// Skills render inside the composer as atomic `contenteditable="false"` spans
// in a plain contenteditable host. Every guard below was measured in Blink,
// Gecko and WebKit; each comment names the engine behaviour it pays for.

export const PILL_CLASS = "composer-pill";
export const ZWSP = "\u200b";
export const NBSP = "\u00a0";

const PILL_SELECTOR = `span.${PILL_CLASS}`;
const BLOCK = /^(DIV|P|LI|BLOCKQUOTE|H[1-6])$/;
const FILLER_RE = /[\u200b\u00a0]/g;
const ZWSP_RE = /\u200b/g;
const NBSP_RE = /\u00a0/g;

// Lookahead on the trailing boundary so `/skill:a /skill:b` matches twice, the
// same shape `lib/composer-skills.ts` uses on plain drafts.
const SKILL_TOKEN_RE = /(^|\s)\/skill:([^\s/]+)(?=\s|$)/g;

export type HostSegment =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "pill"; readonly skill: string };

// nodeType, not `instanceof`: a document from another realm (jsdom under the
// test runner, an iframe) carries its own Text and HTMLElement constructors.
function isText(node: Node | null | undefined): node is Text {
  return !!node && node.nodeType === 3;
}

function isElement(node: Node | null | undefined): node is HTMLElement {
  return !!node && node.nodeType === 1;
}

function isPill(node: Node | null | undefined): node is HTMLElement {
  return isElement(node) && node.classList.contains(PILL_CLASS);
}

/** Holds only structural spacing this module inserted, never a space the user typed. */
function isFillerText(node: Node | null | undefined): node is Text {
  return isText(node) && node.data.replace(FILLER_RE, "") === "";
}

/** Filler with no rendered width, so an arrow press across it looks dead. */
function isZeroWidthFiller(node: Node | null | undefined): node is Text {
  return isText(node) && node.data.replace(ZWSP_RE, "") === "";
}

function collapseCaret(node: Node, offset: number): boolean {
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function caretRange(host: HTMLElement): Range | null {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !host.contains(range.startContainer)) return null;
  return range;
}

/** Last chunk that carries text, "" when nothing has been emitted yet. */
function lastChunk(out: string[]): string {
  for (let i = out.length - 1; i >= 0; i -= 1) if (out[i]) return out[i];
  return "";
}

function serializeNodes(nodes: Iterable<Node>, out: string[]): string[] {
  for (const node of nodes) {
    if (isText(node)) {
      out.push(node.data);
    } else if (node.nodeName === "BR") {
      out.push("\n");
    } else if (isElement(node)) {
      const skill = node.dataset.skill;
      if (skill) {
        out.push(`/skill:${skill}`);
        continue;
      }
      const previous = lastChunk(out);
      if (BLOCK.test(node.nodeName) && previous !== "" && !previous.endsWith("\n")) out.push("\n");
      serializeNodes(node.childNodes, out);
    }
  }
  return out;
}

/** Structural spacing never reaches the caller: ZWSP vanishes, NBSP is a plain space. */
export function normalizeSerialized(raw: string): string {
  return raw.replace(ZWSP_RE, "").replace(NBSP_RE, " ");
}

/**
 * Blink appends a filler "\n" after the last line break so the empty line
 * renders, and a trailing pill always owns a space the user never typed.
 */
export function trimSerializedTail(raw: string): string {
  return raw.replace(/\n$/, "").replace(/[ \t]+$/, "");
}

export function serializeHost(host: HTMLElement): string {
  return trimSerializedTail(normalizeSerialized(serializeNodes(host.childNodes, []).join("")));
}

/**
 * Splits a plain draft into the nodes a host renders. Text segments are
 * verbatim, so re-joining the segments reproduces the input exactly.
 */
export function parseHostSegments(text: string): HostSegment[] {
  const segments: HostSegment[] = [];
  let cut = 0;
  for (const match of text.matchAll(SKILL_TOKEN_RE)) {
    const [whole, lead, skill] = match;
    const before = text.slice(cut, match.index + lead.length);
    if (before) segments.push({ kind: "text", value: before });
    segments.push({ kind: "pill", skill });
    cut = match.index + whole.length;
  }
  const rest = text.slice(cut);
  if (rest) segments.push({ kind: "text", value: rest });
  return segments;
}

function createPill(skill: string): HTMLElement {
  const pill = document.createElement("span");
  pill.className = PILL_CLASS;
  pill.contentEditable = "false";
  pill.dataset.skill = skill;
  pill.textContent = skill;
  return pill;
}

/**
 * Inverse of `serializeHost`, for a restored draft or a recalled history
 * entry. The space behind a token is the pill's own filler, so it is restored
 * as the non-breaking one a fresh insert would have left; a token that ends a
 * line has no such space and `ensurePillBoundaries` supplies what it needs.
 */
export function setHostContent(host: HTMLElement, text: string): void {
  const fragment = document.createDocumentFragment();
  const segments = parseHostSegments(text);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.kind === "pill") {
      fragment.append(createPill(segment.skill));
    } else if (segments[i - 1]?.kind === "pill" && segment.value.startsWith(" ")) {
      fragment.append(document.createTextNode(NBSP + segment.value.slice(1)));
    } else {
      fragment.append(document.createTextNode(segment.value));
    }
  }
  host.replaceChildren(fragment);
  ensurePillBoundaries(host);
}

export function textBeforeCaret(host: HTMLElement): string | null {
  const caret = caretRange(host);
  if (!caret) return null;
  const range = document.createRange();
  range.setStart(host, 0);
  range.setEnd(caret.startContainer, caret.startOffset);
  return normalizeSerialized(serializeNodes(range.cloneContents().childNodes, []).join(""));
}

/**
 * No engine can put a caret past a trailing inline non-editable node, and Gecko
 * drops it INSIDE the node when the neighbouring text is gone. Keep a text node
 * on both sides of every pill so a caret position always exists.
 *
 * The node after a pill is a non-breaking space, not a zero-width one: a
 * collapsed trailing space gives the caret no width to occupy, so WebKit paints
 * it inside the pill's border box. The serializer trims both.
 */
export function ensurePillBoundaries(host: HTMLElement): number {
  let added = 0;
  for (const pill of host.querySelectorAll<HTMLElement>(PILL_SELECTOR)) {
    if (!isText(pill.previousSibling)) {
      pill.before(document.createTextNode(ZWSP));
      added += 1;
    }
    // Once the user has backspaced over the pill's own space, the trailing node
    // shrinks to zero width: the caret still has a home, but the space is
    // visibly gone and the next Backspace takes the pill.
    const filler = pill.dataset.tight === "1" ? ZWSP : NBSP;
    const next = pill.nextSibling;
    if (!isText(next)) {
      pill.after(document.createTextNode(filler));
      added += 1;
    } else if (isFillerText(next) && !next.nextSibling && next.data !== filler) {
      next.data = filler;
      added += 1;
    }
  }
  return added;
}

/**
 * omp expands only the FIRST `/skill:` token in a prompt (`parseSkillInvocation`
 * in its extensibility/skills.ts); later ones reach the model as literal text.
 * Record which is which so the composer can show the difference, and refresh it
 * on every change because editing reorders pills.
 */
export function markPillPrecedence(host: HTMLElement, titles?: { expands: string; literal: string }): void {
  let index = 0;
  for (const pill of host.querySelectorAll<HTMLElement>(PILL_SELECTOR)) {
    const expands = index === 0;
    pill.dataset.expands = expands ? "1" : "0";
    if (titles) pill.title = expands ? titles.expands : titles.literal;
    index += 1;
  }
}

/**
 * WebKit's insertHTML sanitizer drops contenteditable="false"; without it the
 * pill is ordinary editable text. Touch the DOM only when a pill is actually
 * broken: a write on every input invalidates WebKit's undo stack.
 */
export function reassertPills(host: HTMLElement): number {
  let repaired = 0;
  for (const pill of host.querySelectorAll<HTMLElement>(PILL_SELECTOR)) {
    if (pill.getAttribute("contenteditable") !== "false") {
      pill.setAttribute("contenteditable", "false");
      repaired += 1;
    }
  }
  return repaired;
}

/**
 * Gecko and WebKit drop a mouse caret inside a non-editable span, and Gecko
 * keeps it there once the neighbouring text is deleted. Snap into the boundary
 * text node on the nearer side; those nodes always exist.
 */
export function snapCaretOutOfPill(host: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  const element = isText(node) ? node.parentElement : isElement(node) ? node : null;
  const pill = element?.closest<HTMLElement>(PILL_SELECTOR) ?? null;
  if (!pill || !host.contains(pill)) return false;
  ensurePillBoundaries(host);
  const forward = isText(node) ? range.startOffset > node.data.length / 2 : true;
  const target = forward ? pill.nextSibling : pill.previousSibling;
  if (!isText(target)) return false;
  return collapseCaret(target, forward ? Math.min(1, target.data.length) : Math.max(0, target.data.length - 1));
}

/**
 * True when the text immediately before the caret came from a pill rather than
 * from typing. `textBeforeCaret` serializes a pill as `/skill:<name>`, which is
 * indistinguishable from a hand-typed token; a caller that turns typed tokens
 * into pills must ask this first or it will re-pill its own output forever.
 */
export function pillBeforeCaret(host: HTMLElement): HTMLElement | null {
  const caret = caretRange(host);
  if (!caret) return null;
  const node = caret.startContainer;
  let candidate: Node | null;
  if (isText(node)) {
    if (node.data.slice(0, caret.startOffset).replace(FILLER_RE, "") !== "") return null;
    candidate = node.previousSibling;
  } else {
    candidate = caret.startOffset > 0 ? node.childNodes[caret.startOffset - 1] : null;
  }
  while (isText(candidate) && isFillerText(candidate)) candidate = candidate.previousSibling;
  return isPill(candidate) ? candidate : null;
}

/**
 * The pill adjacent to a collapsed caret on the given side. Only zero-width
 * fillers are skipped: the pill's own space is a real stop, so crossing a
 * spaced pill costs one press for the space and one for the pill.
 */
export function adjacentPill(host: HTMLElement, forward: boolean): HTMLElement | null {
  const caret = caretRange(host);
  if (!caret) return null;
  const node = caret.startContainer;
  let candidate: Node | null;
  if (isText(node)) {
    const side = forward ? node.data.slice(caret.startOffset) : node.data.slice(0, caret.startOffset);
    if (side.replace(ZWSP_RE, "") !== "") return null;
    candidate = forward ? node.nextSibling : node.previousSibling;
  } else if (forward) {
    candidate = node.childNodes[caret.startOffset] ?? null;
  } else {
    candidate = caret.startOffset > 0 ? node.childNodes[caret.startOffset - 1] : null;
  }
  while (isZeroWidthFiller(candidate)) candidate = forward ? candidate.nextSibling : candidate.previousSibling;
  return isPill(candidate) ? candidate : null;
}

/**
 * Put the caret on one side of a pill, inside the boundary text node that
 * `ensurePillBoundaries` guarantees exists. It lands past the filler so the
 * next arrow press moves visibly instead of burning a keystroke.
 */
export function caretBesidePill(pill: HTMLElement, forward: boolean): boolean {
  const target = forward ? pill.nextSibling : pill.previousSibling;
  if (!isText(target)) return false;
  const value = target.data;
  const offset = forward
    ? Math.min(value.length, value.startsWith(ZWSP) ? 1 : 0)
    : Math.max(0, value.endsWith(ZWSP) ? value.length - 1 : value.length);
  return collapseCaret(target, offset);
}

/** The pill's own trailing space, still at full width (not yet backspaced). */
export function untightenedSpaceAfterPill(host: HTMLElement): { pill: HTMLElement; node: Text } | null {
  const caret = caretRange(host);
  const node = caret?.startContainer;
  if (!caret || !isText(node)) return null;
  if (node.data.slice(0, caret.startOffset).replace(FILLER_RE, "") !== "") return null;
  if (!node.data.includes(NBSP)) return null;
  let pill: Node | null = node.previousSibling;
  while (isZeroWidthFiller(pill)) pill = pill.previousSibling;
  if (!isPill(pill) || pill.dataset.tight === "1") return null;
  return { pill, node };
}

/**
 * The pill a Backspace should remove: the caret must be collapsed with nothing
 * but boundary fillers between it and the pill.
 */
export function pillToDeleteBackward(host: HTMLElement): HTMLElement | null {
  const caret = caretRange(host);
  if (!caret) return null;
  const node = caret.startContainer;
  let candidate: Node | null;
  if (isText(node)) {
    // The boundary nbsp belongs to the pill, not to the user's text, so a
    // Backspace resting on it deletes the pill rather than nudging whitespace.
    if (node.data.slice(0, caret.startOffset).replace(FILLER_RE, "") !== "") return null;
    // A full-width pill space is consumed by its own Backspace first.
    if (untightenedSpaceAfterPill(host)) return null;
    candidate = node.previousSibling;
  } else {
    candidate = caret.startOffset > 0 ? node.childNodes[caret.startOffset - 1] : null;
  }
  while (isFillerText(candidate)) candidate = candidate.previousSibling;
  return isPill(candidate) ? candidate : null;
}

/**
 * Remove a pill plus its boundary fillers and leave the caret in its place.
 * WebKit silently refuses to delete a non-editable node natively, so deletion
 * is owned here for all three engines.
 */
export function removePill(pill: HTMLElement): void {
  const anchor = document.createTextNode("");
  pill.before(anchor);
  let after = pill.nextSibling;
  pill.remove();
  while (isFillerText(after)) {
    const next = after.nextSibling;
    after.remove();
    after = next;
  }
  collapseCaret(anchor, 0);
}

/**
 * Put the caret just past the pill, inside the text node that always follows
 * it. Engines disagree about where insertHTML leaves the caret when the
 * inserted node is not selectable, so never trust it.
 */
function placeCaretAfterPill(host: HTMLElement, pill: HTMLElement): boolean {
  ensurePillBoundaries(host);
  const gap = pill.nextSibling;
  if (!isText(gap)) return false;
  if (!/^[ \u00a0\u200b]/.test(gap.data)) gap.data = NBSP + gap.data;
  return collapseCaret(gap, gap.data.startsWith(ZWSP) ? Math.min(2, gap.data.length) : 1);
}

/** The pill ships its own trailing space, so absorb the one already there to avoid doubling. */
function absorbSpaceAfter(selection: Selection): void {
  const range = selection.getRangeAt(0);
  const node = range.endContainer;
  if (!isText(node)) return;
  const next = node.data.charAt(range.endOffset);
  if (next !== " " && next !== NBSP) return;
  const merged = document.createRange();
  merged.setStart(range.startContainer, range.startOffset);
  merged.setEnd(node, range.endOffset + 1);
  selection.removeAllRanges();
  selection.addRange(merged);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function newPill(host: HTMLElement, before: ReadonlySet<HTMLElement>): HTMLElement | null {
  for (const pill of host.querySelectorAll<HTMLElement>(PILL_SELECTOR)) if (!before.has(pill)) return pill;
  return null;
}

function insertPillManually(selection: Selection, skill: string): HTMLElement | null {
  if (!selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const pill = createPill(skill);
  const gap = document.createTextNode(NBSP);
  range.insertNode(gap);
  range.insertNode(pill);
  return pill;
}

export function insertPillAtCaret(host: HTMLElement, skill: string): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return false;
  absorbSpaceAfter(selection);
  const before = new Set(host.querySelectorAll<HTMLElement>(PILL_SELECTOR));
  // insertHTML rather than DOM surgery: it is one native undo transaction, so
  // cmd-Z restores the typed query along with the pill.
  const ran = document.execCommand(
    "insertHTML",
    false,
    `<span contenteditable="false" class="${PILL_CLASS}" data-skill="${escapeHtml(skill)}">${escapeHtml(skill)}</span>&nbsp;`,
  );
  let pill = ran ? newPill(host, before) : null;
  if (!pill) pill = insertPillManually(selection, skill);
  if (!pill) return false;
  reassertPills(host);
  placeCaretAfterPill(host, pill);
  return true;
}

export function insertTextAtCaret(text: string): boolean {
  // execCommand keeps the edit inside the browser's undo stack; a manual Range
  // insertion is invisible to cmd-Z.
  if (document.execCommand("insertText", false, text)) return true;
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  return collapseCaret(node, node.data.length);
}

/**
 * Swap the `count` characters behind the caret for `text`. The selection is
 * extended rather than deleted so the whole swap is one native undo step.
 */
export function replaceBeforeCaret(host: HTMLElement, count: number, text: string): boolean {
  const selection = window.getSelection();
  if (!selection || !caretRange(host)) return false;
  for (let i = 0; i < count; i += 1) selection.modify("extend", "backward", "character");
  return insertTextAtCaret(text);
}
