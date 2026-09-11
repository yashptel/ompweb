import assert from "node:assert/strict";
import test from "node:test";
import { NBSP, ZWSP, normalizeSerialized, parseHostSegments, trimSerializedTail } from "./pill-editor.ts";

const text = (value) => ({ kind: "text", value });
const pill = (skill) => ({ kind: "pill", skill });

const rejoin = (segments) =>
  segments.map((segment) => (segment.kind === "pill" ? `/skill:${segment.skill}` : segment.value)).join("");

test("a skill token becomes a pill and the surrounding text keeps its spacing", () => {
  assert.deepEqual(parseHostSegments("/skill:how"), [pill("how")]);
  assert.deepEqual(parseHostSegments("/skill:how "), [pill("how"), text(" ")]);
  assert.deepEqual(parseHostSegments("/skill:how fix it"), [pill("how"), text(" fix it")]);
  assert.deepEqual(parseHostSegments("fix /skill:how it"), [text("fix "), pill("how"), text(" it")]);
  assert.deepEqual(parseHostSegments("/skill:a /skill:b"), [pill("a"), text(" "), pill("b")]);
  assert.deepEqual(parseHostSegments("/skill:how\nfix"), [pill("how"), text("\nfix")]);
  // A restored draft can carry the host's own non-breaking filler.
  assert.deepEqual(parseHostSegments(`/skill:how${NBSP}fix`), [pill("how"), text(`${NBSP}fix`)]);
});

test("text that only looks like a token stays text", () => {
  for (const input of ["/skillet", "a/skill:b", "lib/skill:b", "/skill:", "/skill:a/b", "/skill: a", "skill:a"]) {
    assert.deepEqual(parseHostSegments(input), [text(input)], input);
  }
});

test("empty text produces no nodes at all", () => {
  assert.deepEqual(parseHostSegments(""), []);
});

test("segments re-join to the exact input, so nothing is lost on restore", () => {
  for (const input of [
    "",
    "just text",
    "/skill:how",
    "/skill:how fix the bug",
    "/skill:a /skill:b tail",
    "lead /skill:how\nsecond line",
    "keeps  double  spaces",
    "/skillet is not a token",
    `${NBSP}odd${ZWSP}spacing `,
  ]) {
    assert.equal(rejoin(parseHostSegments(input)), input, input);
  }
});

test("serialized text drops zero-width fillers and reads non-breaking ones as spaces", () => {
  assert.equal(normalizeSerialized(`${ZWSP}/skill:how${NBSP}`), "/skill:how ");
  assert.equal(normalizeSerialized(`a${ZWSP}b`), "ab");
  assert.equal(normalizeSerialized("plain  text\n"), "plain  text\n");
});

test("the tail trim drops the trailing pill space and Blink's filler newline", () => {
  assert.equal(trimSerializedTail("/skill:how "), "/skill:how");
  assert.equal(trimSerializedTail("two lines\n"), "two lines");
  assert.equal(trimSerializedTail("blank line\n\n"), "blank line\n");
  assert.equal(trimSerializedTail("trailing tab\t"), "trailing tab");
  assert.equal(trimSerializedTail("kept\n  indent"), "kept\n  indent");
  assert.equal(trimSerializedTail("line \nnext"), "line \nnext");
});
