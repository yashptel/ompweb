import assert from "node:assert/strict";
import test from "node:test";
import { countSkillTokens, extractSlashToken } from "./slash-token.ts";

test("a token opening the draft is a leading command, with or without a query", () => {
  assert.deepEqual(extractSlashToken("/", 1), { kind: "command", start: 0, query: "", expands: true });
  assert.deepEqual(extractSlashToken("/goa", 4), { kind: "command", start: 0, query: "goa", expands: true });
  assert.deepEqual(extractSlashToken("  /goa", 6), { kind: "command", start: 2, query: "goa", expands: true });
});

test("a token after a newline is leading only when everything before it is whitespace", () => {
  assert.deepEqual(extractSlashToken("\n  \n/pl", 7), { kind: "command", start: 4, query: "pl", expands: true });
  assert.deepEqual(extractSlashToken("hi\n/pl", 6), { kind: "skill", start: 3, query: "pl", expands: true });
});

test("a token mid-sentence is a skill token at the slash index", () => {
  assert.deepEqual(extractSlashToken("fix the bug /sk", 15), { kind: "skill", start: 12, query: "sk", expands: true });
  assert.deepEqual(extractSlashToken("fix the bug /skill:re", 21), {
    kind: "skill",
    start: 12,
    query: "skill:re",
    expands: true,
  });
});

test("only text before the caret forms the token, but the whole draft gates it", () => {
  assert.deepEqual(extractSlashToken("fix the bug /sk now please", 15), {
    kind: "skill",
    start: 12,
    query: "sk",
    expands: true,
  });
  // The caret sits inside the token, so the tail of the token is not part of the query.
  assert.deepEqual(extractSlashToken("/goal now", 3), { kind: "command", start: 0, query: "go", expands: true });
  // Out-of-range carets clamp instead of throwing.
  assert.deepEqual(extractSlashToken("/goal", 99), { kind: "command", start: 0, query: "goal", expands: true });
  assert.equal(extractSlashToken("/goal", -3), null);
});

test("a slash needs whitespace or the start of the draft before it", () => {
  assert.equal(extractSlashToken("a/b", 3), null);
  assert.equal(extractSlashToken("lib/slash", 9), null);
  assert.equal(extractSlashToken("fix the bug /sk ", 16), null);
});

test("the menu still opens where omp would not expand, but says so through expands", () => {
  // A non-skill command or an execution sigil owns the whole draft in omp.
  assert.deepEqual(extractSlashToken("/compact and /sk", 16), { kind: "skill", start: 13, query: "sk", expands: false });
  assert.deepEqual(extractSlashToken("!ls /sk", 7), { kind: "skill", start: 4, query: "sk", expands: false });
  assert.deepEqual(extractSlashToken("$ echo /sk", 10), { kind: "skill", start: 7, query: "sk", expands: false });
  assert.deepEqual(extractSlashToken("$$ echo /sk", 11), { kind: "skill", start: 8, query: "sk", expands: false });

  // A draft opening with /skill: is itself a skill invocation, so a second
  // token is literal — but the menu must still open there.
  assert.deepEqual(extractSlashToken("/skill:wayfinder hi /sk", 23), {
    kind: "skill",
    start: 20,
    query: "sk",
    expands: false,
  });
  // An earlier skill token anywhere already consumed omp's one expansion.
  assert.deepEqual(extractSlashToken("use /skill:how then /sk", 23), {
    kind: "skill",
    start: 20,
    query: "sk",
    expands: false,
  });

  assert.deepEqual(extractSlashToken("${HOME} /sk", 11), { kind: "skill", start: 8, query: "sk", expands: true });
  assert.deepEqual(extractSlashToken("$HOME /sk", 9), { kind: "skill", start: 6, query: "sk", expands: true });
});

test("skill tokens are counted per whitespace-delimited occurrence", () => {
  assert.equal(countSkillTokens(""), 0);
  assert.equal(countSkillTokens("fix the bug"), 0);
  assert.equal(countSkillTokens("/skillet"), 0);
  assert.equal(countSkillTokens("see lib/skill:a"), 0);
  assert.equal(countSkillTokens("/skill:"), 0);

  assert.equal(countSkillTokens("/skill:how"), 1);
  assert.equal(countSkillTokens("fix the bug /skill:how please"), 1);

  assert.equal(countSkillTokens("/skill:a /skill:b"), 2);
  assert.equal(countSkillTokens("do /skill:a then\n/skill:b now"), 2);
});
