// Pure helpers for the composer's slash-command menu. Mirrors omp's slash
// semantics: every command is leading-only, while `/skill:<name>` is the one
// form omp also honors mid-prompt (`parseSkillInvocation` in
// extensibility/skills.ts).

export type SlashTokenKind = "command" | "skill";

export interface SlashToken {
  /** "command" when the token opens the draft, "skill" for a mid-prompt token */
  kind: SlashTokenKind;
  /** Index of the "/" character in the full text */
  start: number;
  /** Raw text typed after the "/" (not lowercased); may be empty */
  query: string;
  /**
   * Whether omp would actually expand a skill inserted here. False means the
   * token still reaches the model, but only as literal text.
   */
  expands: boolean;
}

/**
 * Detect the slash token immediately before the caret. The "/" must start the
 * text or follow whitespace (same rule as the @ token in `file-fuzzy.ts`), so
 * paths like a/b never trigger.
 *
 * `expands` reports omp's `parseSkillInvocation` rules for a mid-prompt token:
 * omp expands the first `/skill:<name>` token only, and skips mid-prompt
 * detection entirely when the draft opens with a non-skill slash command or a
 * local-execution sigil, because those handlers consume their bodies verbatim.
 */
export function extractSlashToken(text: string, caret: number): SlashToken | null {
  const cursor = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, cursor);
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(before);
  if (!match) return null;

  const query = match[1];
  const start = before.length - (query.length + 1);

  const trimmed = text.trimStart();
  // The token is leading exactly when it holds the first non-whitespace char.
  if (text.length - trimmed.length === start) return { kind: "command", start, query, expands: true };

  const draftOwnsDispatch = (trimmed.startsWith("/") && !trimmed.startsWith("/skill:"))
    || startsWithLocalExecutionPrefix(trimmed);
  const expands = !draftOwnsDispatch && countSkillTokens(text.slice(0, start)) === 0;
  return { kind: "skill", start, query, expands };
}

/**
 * Whether the (already left-trimmed) draft begins with a local-execution
 * sigil — `!` for the bash tool, `$`/`$$` followed by ASCII whitespace or end
 * of input for the python tool. Ported from `startsWithLocalExecutionPrefix`
 * in omp's extensibility/skills.ts; `${` is a shell expansion, not a sigil.
 */
function startsWithLocalExecutionPrefix(trimmed: string): boolean {
  if (trimmed.startsWith("!")) return true;
  if (trimmed.charCodeAt(0) !== 36 /* $ */) return false;
  if (trimmed.charCodeAt(1) === 123 /* { */) return false;
  const sigilLength = trimmed.charCodeAt(1) === 36 /* $ */ ? 2 : 1;
  const next = trimmed.charCodeAt(sigilLength);
  if (Number.isNaN(next)) return true;
  return next === 32 /* space */ || next === 9 /* tab */ || next === 10 /* LF */ || next === 13; /* CR */
}

// Lookahead on the trailing boundary so `/skill:a /skill:b` counts twice: a
// consumed separator would hide the second token's required leading space.
const SKILL_TOKEN_RE = /(?:^|\s)\/skill:[^\s/]+(?=\s|$)/g;

/** Number of whitespace-delimited `/skill:<name>` tokens in the text. */
export function countSkillTokens(text: string): number {
  SKILL_TOKEN_RE.lastIndex = 0;
  let count = 0;
  while (SKILL_TOKEN_RE.exec(text) !== null) count++;
  return count;
}
