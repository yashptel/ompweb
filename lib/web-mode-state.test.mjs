import assert from "node:assert/strict";
import test from "node:test";
import {
  NO_COMPOSER_MODES,
  applyComposerModes,
  createActiveGoal,
  formatGoalElapsed,
  parseComposerModes,
  serializeComposerModes,
} from "./web-mode-state.ts";

const GOAL = { objective: "Ship the export", startedAt: 123 };

test("goal state trims its objective and keeps its start time", () => {
  assert.deepEqual(createActiveGoal("  Ship the sidebar  ", 123), {
    objective: "Ship the sidebar",
    startedAt: 123,
  });
});

test("composer modes parser accepts a well-formed record", () => {
  assert.deepEqual(parseComposerModes('{"plan":true,"goal":null}'), { plan: true, goal: null });
  assert.deepEqual(parseComposerModes('{"plan":false,"goal":{"objective":"  Ship it  ","startedAt":123}}'), {
    plan: false,
    goal: { objective: "Ship it", startedAt: 123 },
  });
});

test("composer modes parser falls back to no modes for every malformed shape", () => {
  for (const raw of [
    null,
    "",
    "not JSON",
    "null",
    '"a string"',
    "[]",
    '{"goal":null}',
    '{"plan":"yes","goal":null}',
    '{"plan":true,"goal":[]}',
    '{"plan":true,"goal":"Ship it"}',
    '{"plan":true,"goal":{"objective":"","startedAt":123}}',
    '{"plan":true,"goal":{"objective":"   ","startedAt":123}}',
    '{"plan":true,"goal":{"objective":"Ship it","startedAt":"123"}}',
    '{"plan":true,"goal":{"objective":"Ship it","startedAt":-1}}',
  ]) {
    assert.deepEqual(parseComposerModes(raw), NO_COMPOSER_MODES, raw ?? "null input");
  }
});

test("composer modes survive a serialize/parse round trip", () => {
  for (const modes of [
    NO_COMPOSER_MODES,
    { plan: true, goal: null },
    { plan: false, goal: GOAL },
    { plan: true, goal: GOAL },
  ]) {
    assert.deepEqual(parseComposerModes(serializeComposerModes(modes)), modes);
  }
});

test("the shared no-modes default cannot be mutated by a caller", () => {
  assert.throws(() => {
    NO_COMPOSER_MODES.plan = true;
  });
});

test("no active mode leaves the message untouched", () => {
  assert.equal(applyComposerModes("do the thing", NO_COMPOSER_MODES), "do the thing");
});

test("an active mode prefixes one line per mode, goal before plan", () => {
  const goalLine = "[Goal] Ship the export — keep prioritizing this objective when deciding what to do next.";
  const planLine = "[Plan mode] Plan the work step by step and get approval before changing anything.";

  assert.equal(applyComposerModes("do the thing", { plan: false, goal: GOAL }), `${goalLine}\n\ndo the thing`);
  assert.equal(applyComposerModes("do the thing", { plan: true, goal: null }), `${planLine}\n\ndo the thing`);
  assert.equal(
    applyComposerModes("do the thing", { plan: true, goal: GOAL }),
    `${goalLine}\n${planLine}\n\ndo the thing`,
  );
});

test("goal elapsed formatter is stable at minute and hour boundaries", () => {
  assert.equal(formatGoalElapsed(-1), "0m");
  assert.equal(formatGoalElapsed(59_999), "0m");
  assert.equal(formatGoalElapsed(60_000), "1m");
  assert.equal(formatGoalElapsed(3_660_000), "1h 1m");
});
