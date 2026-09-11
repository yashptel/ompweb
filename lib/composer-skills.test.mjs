import assert from "node:assert/strict";
import test from "node:test";
import { skillNameFromCommandName, splitLeadingSkillTokens } from "./composer-skills.ts";


test("only tokens at the very front are split off a sent message", () => {
  assert.deepEqual(splitLeadingSkillTokens("fix /skill:how auth"), {
    body: "fix /skill:how auth",
    skills: [],
  });
  assert.deepEqual(splitLeadingSkillTokens("fix auth"), { body: "fix auth", skills: [] });
  assert.deepEqual(splitLeadingSkillTokens("/skill:a use /skill:b too"), { body: "use /skill:b too", skills: ["a"] });
  assert.deepEqual(splitLeadingSkillTokens("/skill:a"), { body: "", skills: ["a"] });
});

test("a command name yields a skill name only when it carries one", () => {
  assert.equal(skillNameFromCommandName("skill:wayfinder"), "wayfinder");
  assert.equal(skillNameFromCommandName("compact"), null);
  assert.equal(skillNameFromCommandName("skill:"), null);
});
