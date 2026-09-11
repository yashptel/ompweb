// Skills picked in the composer are inline pills in the draft, serialized as
// `/skill:<name>` tokens in place. omp expands only the FIRST such token
// (`parseSkillInvocation` in omp's extensibility/skills.ts), which is why the
// transcript splits only the leading run back out.

const SKILL_COMMAND_PREFIX = "skill:";

// Lookahead on the trailing boundary so `/skill:a /skill:b` matches twice: a
// consumed separator would hide the second token's required leading whitespace.
const SKILL_TOKEN_RE = /(^|\s)\/skill:([^\s/]+)(?=\s|$)/g;

/** Bare skill name behind an omp `skill:<name>` command name; null for any other command. */
export function skillNameFromCommandName(commandName: string): string | null {
  if (!commandName.startsWith(SKILL_COMMAND_PREFIX)) return null;
  return commandName.slice(SKILL_COMMAND_PREFIX.length) || null;
}


/**
 * Split the `/skill:<name>` tokens omp expands off the front of a sent message.
 * A token reached only after other text belongs to the body and is left there.
 */
export function splitLeadingSkillTokens(text: string): { body: string; skills: string[] } {
  const skills: string[] = [];
  let cut = 0;
  for (const match of text.matchAll(SKILL_TOKEN_RE)) {
    const [whole, lead, name] = match;
    if (text.slice(cut, match.index + lead.length).trim().length > 0) break;
    skills.push(name);
    cut = match.index + whole.length;
  }
  if (skills.length === 0) return { body: text, skills };
  return { body: text.slice(cut).trimStart(), skills };
}
