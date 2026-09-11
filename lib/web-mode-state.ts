/**
 * Composer mode state (plan / goal).
 *
 * These are omp-web modes, not omp's: the rpc-ui protocol has no command to
 * set plan or goal mode, so an active mode is expressed as a short preamble
 * prefixed to every outgoing prompt.
 */

export interface ActiveGoal {
  objective: string;
  startedAt: number;
}

export interface ComposerModes {
  plan: boolean;
  goal: ActiveGoal | null;
}

export const NO_COMPOSER_MODES: ComposerModes = Object.freeze({ plan: false, goal: null });

export function createActiveGoal(objective: string, startedAt = Date.now()): ActiveGoal {
  return { objective: objective.trim(), startedAt };
}

/** Parse sessionStorage safely: user data and old versions must never break chat. */
export function parseComposerModes(raw: string | null): ComposerModes {
  if (!raw) return NO_COMPOSER_MODES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NO_COMPOSER_MODES;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return NO_COMPOSER_MODES;
  const { plan, goal } = parsed as Record<string, unknown>;
  if (typeof plan !== "boolean") return NO_COMPOSER_MODES;
  if (goal === null || goal === undefined) return plan ? { plan, goal: null } : NO_COMPOSER_MODES;
  if (typeof goal !== "object" || Array.isArray(goal)) return NO_COMPOSER_MODES;
  const { objective, startedAt } = goal as Record<string, unknown>;
  if (typeof objective !== "string" || !objective.trim()) return NO_COMPOSER_MODES;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt < 0) return NO_COMPOSER_MODES;
  return { plan, goal: { objective: objective.trim(), startedAt } };
}

export function serializeComposerModes(modes: ComposerModes): string {
  return JSON.stringify({ plan: modes.plan, goal: modes.goal });
}

const PLAN_PREAMBLE = "[Plan mode] Plan the work step by step and get approval before changing anything.";

/** Modes reach the model as prompt text, so these lines are never i18n keys. */
export function applyComposerModes(message: string, modes: ComposerModes): string {
  const preamble: string[] = [];
  if (modes.goal) {
    preamble.push(`[Goal] ${modes.goal.objective} — keep prioritizing this objective when deciding what to do next.`);
  }
  if (modes.plan) preamble.push(PLAN_PREAMBLE);
  if (preamble.length === 0) return message;
  return `${preamble.join("\n")}\n\n${message}`;
}

export function formatGoalElapsed(elapsedMs: number): string {
  const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
