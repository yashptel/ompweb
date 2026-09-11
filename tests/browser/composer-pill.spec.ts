import { expect, test, type Locator, type Page } from "playwright/test";

/**
 * Regression suite for the six browser guards in the PillEditor contract. Each
 * guard exists because a shipped engine broke; these tests are what catches a
 * browser release quietly un-breaking one. Run against all three projects, not
 * just chromium: every guard was measured in a different engine.
 */

// Every selector here is product contract: the two composer test hooks plus the
// pill's own class and data attributes.
const HOST = '[data-testid="composer-editor"]';
const SLASH_MENU = '[data-testid="composer-slash-menu"]';
const PILL = "span.composer-pill[data-skill]";

// The real skill list arrives over RPC (`get_commands`), which needs a live
// `omp` child process and makes the menu contents depend on the machine. What
// is under test is the pill editor, not omp's command discovery, so the command
// source is stubbed and every failure below points at the editor.
const STUB_SKILLS = [
  { name: "skill:paprika", description: "pill regression probe", source: "skill" },
  { name: "skill:quinoa", description: "pill regression probe", source: "skill" },
];

interface PillState {
  skill: string;
  tight: boolean;
  atomic: boolean;
}

interface CaretProbe {
  hasSelection: boolean;
  insidePillNode: boolean;
  insidePillBox: boolean;
  pillBefore: string | null;
  pillAfter: string | null;
  /** Serialized draft up to the caret. NBSP renders as `_` so a caret on one
   *  side of a pill's structural space is distinguishable from the other. */
  before: string;
  /** Whole serialized draft, NBSP normalized to a plain space. */
  text: string;
  pills: PillState[];
}

async function readCaret(page: Page): Promise<CaretProbe> {
  return page.evaluate(
    ({ hostSelector, pillSelector }) => {
      const ZWSP = /\u200b/g;
      const FILLER = /[\u200b\u00a0]/g;
      const host = document.querySelector(hostSelector);
      if (!host) {
        return {
          hasSelection: false,
          insidePillNode: false,
          insidePillBox: false,
          pillBefore: null,
          pillAfter: null,
          before: "",
          text: "",
          pills: [],
        } satisfies CaretProbe;
      }

      const pills = [...host.querySelectorAll(pillSelector)].filter(
        (el): el is HTMLElement => el instanceof HTMLElement,
      );
      const states: PillState[] = pills.map((pill) => ({
        skill: pill.dataset.skill ?? "",
        tight: pill.dataset.tight === "1",
        atomic: pill.getAttribute("contenteditable") === "false",
      }));

      const write = (nodes: Iterable<ChildNode>): string => {
        let out = "";
        for (const node of nodes) {
          if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue ?? "";
          else if (node.nodeName === "BR") out += "\n";
          else if (node instanceof HTMLElement) {
            out += node.dataset.skill ? `/skill:${node.dataset.skill}` : write(node.childNodes);
          }
        }
        return out;
      };
      const text = write(host.childNodes).replace(ZWSP, "").replace(/\u00a0/g, " ");
      const blank: CaretProbe = {
        hasSelection: false,
        insidePillNode: false,
        insidePillBox: false,
        pillBefore: null,
        pillAfter: null,
        before: "",
        text,
        pills: states,
      };

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return blank;
      const range = selection.getRangeAt(0);
      if (!range.collapsed || !host.contains(range.startContainer)) return blank;

      const container = range.startContainer;
      const element =
        container.nodeType === Node.TEXT_NODE ? container.parentElement : (container as Element);

      // Structural fillers are skipped; anything the user typed is a real stop,
      // so a pill "before" the caret means nothing but this editor's own
      // spacing sits between them.
      const neighbour = (forward: boolean): string | null => {
        let candidate: ChildNode | null;
        if (container.nodeType === Node.TEXT_NODE) {
          const value = container.nodeValue ?? "";
          const part = forward ? value.slice(range.startOffset) : value.slice(0, range.startOffset);
          if (part.replace(FILLER, "") !== "") return null;
          candidate = forward ? container.nextSibling : container.previousSibling;
        } else {
          const children = container.childNodes;
          candidate = forward
            ? children[range.startOffset] ?? null
            : range.startOffset > 0
              ? children[range.startOffset - 1]
              : null;
        }
        while (
          candidate &&
          candidate.nodeType === Node.TEXT_NODE &&
          (candidate.nodeValue ?? "").replace(FILLER, "") === ""
        ) {
          candidate = forward ? candidate.nextSibling : candidate.previousSibling;
        }
        return candidate instanceof HTMLElement && candidate.dataset.skill
          ? candidate.dataset.skill
          : null;
      };

      const prefix = document.createRange();
      prefix.setStart(host, 0);
      prefix.setEnd(range.startContainer, range.startOffset);
      const caret = range.cloneRange().getBoundingClientRect();

      return {
        hasSelection: true,
        insidePillNode: !!element?.closest(pillSelector),
        insidePillBox: pills.some((pill) => {
          const box = pill.getBoundingClientRect();
          return (
            caret.left > box.left &&
            caret.left < box.right &&
            caret.bottom > box.top &&
            caret.top < box.bottom
          );
        }),
        pillBefore: neighbour(false),
        pillAfter: neighbour(true),
        before: write(prefix.cloneContents().childNodes).replace(ZWSP, "").replace(/\u00a0/g, "_"),
        text,
        pills: states,
      } satisfies CaretProbe;
    },
    { hostSelector: HOST, pillSelector: PILL },
  );
}

/**
 * The caret once the composer has stopped moving it. Asserting on the DOM the
 * instant after a keypress can pass on a caret that a React effect is about to
 * drag back, and a human types far slower than that effect runs, so the settled
 * position is the only one they ever see.
 */
async function settledCaret(page: Page): Promise<CaretProbe> {
  let previous = await readCaret(page);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.waitForTimeout(120);
    const next = await readCaret(page);
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    previous = next;
  }
  return previous;
}

interface Composer {
  host: Locator;
  menu: Locator;
  pills: Locator;
  /** Prompts the composer handed to the agent API, newest last. */
  sent: string[];
}

async function openComposer(page: Page): Promise<Composer> {
  const sent: string[] = [];
  // Only the command endpoint itself: the sibling `/events` SSE streams must
  // keep flowing or the chat view never settles.
  await page.route(/\/api\/agent\/[^/?]+(\?[^/]*)?$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    let command: { type?: string; message?: string } = {};
    try {
      command = JSON.parse(request.postData() ?? "{}") as typeof command;
    } catch {
      return route.fallback();
    }
    // Every /api/agent route answers `{ success, data }`; sendAgentCommand
    // unwraps `data` and treats a bare body as an error.
    if (command.type === "get_commands") {
      return route.fulfill({ json: { success: true, data: { commands: STUB_SKILLS } } });
    }
    if (command.type === "prompt" || (!command.type && typeof command.message === "string")) {
      sent.push(command.message ?? "");
      return route.fulfill({ json: { success: true, data: {} } });
    }
    return route.fallback();
  });

  const listed = await page.request.get("/api/sessions");
  expect(listed.ok(), "GET /api/sessions must succeed to reach a composer").toBeTruthy();
  const { sessions } = (await listed.json()) as { sessions?: { id: string }[] };
  const sessionId = sessions?.[0]?.id;
  if (!sessionId) {
    throw new Error("no omp session on disk: the composer is only reachable inside a session");
  }

  await page.goto(`/?session=${encodeURIComponent(sessionId)}`);
  const host = page.locator(HOST);
  // The sidebar hydrates the session tree over the network before the chat
  // column mounts, so wait on the composer itself rather than a fixed delay.
  await host.waitFor({ state: "visible", timeout: 45_000 });
  await host.click();
  return { host, menu: page.locator(SLASH_MENU), pills: page.locator(PILL), sent };
}

async function insertPill(page: Page, composer: Composer, lead: string, skill: string): Promise<void> {
  const existing = await composer.pills.count();
  await page.keyboard.type(`${lead}/${skill}`);
  await expect(composer.menu).toBeVisible();
  await expect(composer.menu).toContainText(`/skill:${skill}`);
  await page.keyboard.press("Enter");
  await expect(composer.menu).toBeHidden();
  await expect(composer.pills).toHaveCount(existing + 1);
  await settledCaret(page);
}

test.describe("composer skill pill", () => {
  test("a mid-prompt slash opens the skill menu and picking inserts an inline pill", async ({ page }) => {
    const composer = await openComposer(page);
    await insertPill(page, composer, "hi ", "paprika");

    const probe = await settledCaret(page);
    expect(probe.pills).toEqual([{ skill: "paprika", tight: false, atomic: true }]);
    expect(probe.text.trimEnd()).toBe("hi /skill:paprika");
    expect(probe.text).not.toContain("/paprika");
  });

  test("the caret never lands inside a pill", async ({ page }) => {
    const composer = await openComposer(page);
    await insertPill(page, composer, "hi ", "paprika");

    const afterInsert = await settledCaret(page);
    expect(afterInsert.hasSelection).toBe(true);
    expect(afterInsert.insidePillNode).toBe(false);
    expect(afterInsert.insidePillBox).toBe(false);

    const box = await composer.pills.first().boundingBox();
    expect(box, "pill must be laid out to click its centre").not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const afterClick = await settledCaret(page);
    expect(afterClick.insidePillNode).toBe(false);
    // WebKit's bug was purely visual: the caret sat in the right node and
    // painted inside the pill's border box anyway.
    expect(afterClick.insidePillBox).toBe(false);

    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    const afterLeft = await settledCaret(page);
    expect(afterLeft.insidePillNode).toBe(false);
    expect(afterLeft.insidePillBox).toBe(false);

    await page.keyboard.press("ArrowRight");
    const afterRight = await settledCaret(page);
    expect(afterRight.insidePillNode).toBe(false);
    expect(afterRight.insidePillBox).toBe(false);
  });

  test("backspace collapses the pill's space first and removes the pill second", async ({ page }) => {
    const composer = await openComposer(page);
    await insertPill(page, composer, "hi ", "paprika");

    await page.keyboard.press("Backspace");
    const tightened = await settledCaret(page);
    expect(tightened.pills).toEqual([{ skill: "paprika", tight: true, atomic: true }]);
    expect(tightened.insidePillBox).toBe(false);

    await page.keyboard.press("Backspace");
    await expect(composer.pills).toHaveCount(0);
    const removed = await settledCaret(page);
    expect(removed.text.trimEnd()).toBe("hi");
  });

  test("arrows cost one press onto the space and one across the pill, both ways", async ({ page }) => {
    const composer = await openComposer(page);
    await insertPill(page, composer, "hi ", "paprika");

    const start = await settledCaret(page);
    expect(start.pillBefore).toBe("paprika");
    expect(start.before.endsWith("_")).toBe(true);

    await page.keyboard.press("ArrowLeft");
    const ontoSpace = await settledCaret(page);
    expect(ontoSpace.pillBefore).toBe("paprika");
    expect(ontoSpace.before.endsWith("_")).toBe(false);

    await page.keyboard.press("ArrowLeft");
    const acrossPill = await settledCaret(page);
    expect(acrossPill.pillBefore).toBeNull();
    expect(acrossPill.pillAfter).toBe("paprika");
    expect(acrossPill.before).toBe("hi ");

    await page.keyboard.press("ArrowRight");
    const backAcross = await settledCaret(page);
    expect(backAcross.pillAfter).toBeNull();
    expect(backAcross.pillBefore).toBe("paprika");
    expect(backAcross.before.endsWith("_")).toBe(false);

    await page.keyboard.press("ArrowRight");
    const backOverSpace = await settledCaret(page);
    expect(backOverSpace.before.endsWith("_")).toBe(true);
    expect(backOverSpace.before).toBe(start.before);
  });

  test("only the first pill is marked as the one omp expands", async ({ page }) => {
    const composer = await openComposer(page);
    await insertPill(page, composer, "run ", "paprika");
    await insertPill(page, composer, "then ", "quinoa");

    const readMarks = (els: Element[]) =>
      els.map((el) => ({ skill: (el as HTMLElement).dataset.skill, expands: (el as HTMLElement).dataset.expands }));
    expect(await composer.pills.evaluateAll(readMarks)).toEqual([
      { skill: "paprika", expands: "1" },
      { skill: "quinoa", expands: "0" },
    ]);

    // The marking is recomputed from document order on every change, so
    // removing a pill must leave the remaining one correctly marked.
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(composer.pills).toHaveCount(1);
    expect(await composer.pills.evaluateAll(readMarks)).toEqual([{ skill: "paprika", expands: "1" }]);
  });

  test("two consecutive pills cross with no dead arrow press", async ({ page }) => {
    const composer = await openComposer(page);
    await insertPill(page, composer, "a ", "paprika");
    await insertPill(page, composer, "", "quinoa");

    const inserted = await settledCaret(page);
    expect(inserted.pills).toEqual([
      { skill: "paprika", tight: false, atomic: true },
      { skill: "quinoa", tight: false, atomic: true },
    ]);
    expect(inserted.insidePillNode).toBe(false);
    expect(inserted.insidePillBox).toBe(false);
    expect(inserted.pillBefore).toBe("quinoa");

    // Guard 6: a pill plus its fillers is several DOM caret positions on one
    // visual spot. Every press must move, and none may land inside a pill.
    const walk: CaretProbe[] = [inserted];
    for (let press = 0; press < 5 && walk[walk.length - 1].pillAfter !== "paprika"; press += 1) {
      await page.keyboard.press("ArrowLeft");
      walk.push(await settledCaret(page));
    }
    for (const step of walk) {
      expect(step.insidePillNode).toBe(false);
      expect(step.insidePillBox).toBe(false);
    }
    const trace = walk.map((step) => step.before);
    const dead = trace.filter((position, i) => i > 0 && position === trace[i - 1]);
    expect(dead, `every ArrowLeft must move the caret; trace was ${JSON.stringify(trace)}`).toEqual([]);
    const crossedBoth = walk[walk.length - 1];
    expect(crossedBoth.pillBefore).toBeNull();
    expect(crossedBoth.pillAfter).toBe("paprika");
    // One press per pill and one per space, with the space between the two
    // pills shared: four stops at most, not six.
    expect(walk.length - 1).toBeLessThanOrEqual(4);

    for (let press = walk.length - 1; press > 0; press -= 1) await page.keyboard.press("ArrowRight");
    expect((await settledCaret(page)).before).toBe(inserted.before);
  });

  test("two consecutive pills delete like one", async ({ page }) => {
    const composer = await openComposer(page);
    await insertPill(page, composer, "a ", "paprika");
    await insertPill(page, composer, "", "quinoa");

    await page.keyboard.press("Backspace");
    expect((await settledCaret(page)).pills).toEqual([
      { skill: "paprika", tight: false, atomic: true },
      { skill: "quinoa", tight: true, atomic: true },
    ]);
    await page.keyboard.press("Backspace");
    expect((await settledCaret(page)).pills.map((pill) => pill.skill)).toEqual(["paprika"]);
    // The gap the two pills shared went with the second pill, so the first
    // needs no separate tightening press.
    await page.keyboard.press("Backspace");
    await expect(composer.pills).toHaveCount(0);
    expect((await settledCaret(page)).text.trimEnd()).toBe("a");
  });

  test('contenteditable="false" survives insert, typing and a plain-text paste', async ({ page }) => {
    const composer = await openComposer(page);
    await insertPill(page, composer, "hi ", "paprika");
    expect((await settledCaret(page)).pills.map((pill) => pill.atomic)).toEqual([true]);

    await page.keyboard.type("typed");
    expect((await settledCaret(page)).pills.map((pill) => pill.atomic)).toEqual([true]);

    // A synthetic ClipboardEvent never reaches the sanitizer in Gecko, which
    // ignores clipboardData on an untrusted event, so paste for real.
    await page.evaluate(() => navigator.clipboard.writeText(" pasted"));
    await page.keyboard.press("ControlOrMeta+V");
    await expect.poll(async () => (await readCaret(page)).text).toContain("pasted");

    const pasted = await settledCaret(page);
    expect(pasted.pills.map((pill) => pill.atomic)).toEqual([true]);
    expect(pasted.pills.map((pill) => pill.skill)).toEqual(["paprika"]);
  });

  test("a pill mid-sentence serializes to /skill:<name> in place", async ({ page }) => {
    const composer = await openComposer(page);
    await insertPill(page, composer, "check ", "paprika");
    await page.keyboard.type("then ship");

    await page.keyboard.press("Enter");
    await expect.poll(() => composer.sent.length, { timeout: 20_000 }).toBe(1);

    const message = composer.sent[0];
    expect(message).toContain("check /skill:paprika then ship");
    expect(message).not.toMatch(/[\u200b\u00a0]/);
  });
});
