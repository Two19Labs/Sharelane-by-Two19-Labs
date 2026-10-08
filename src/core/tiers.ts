// Model tiers: the delegating agent (or you) picks how hard a task is, and
// each agent's adapter maps that tier to a real model or reasoning effort.
// Picking a tier costs nothing extra: whoever delegates has already read the
// task. When nobody picks, a free keyword check guesses.

import type { AgentAdapter } from "../adapters/adapter.js";

export const MODEL_TIERS = ["fast", "balanced", "strong"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
/** What a caller may ask for: a tier, "auto" (guess), or "default" (the agent's own setting). */
export type TierRequest = ModelTier | "auto" | "default";

export interface TierChoice {
  /** undefined means the agent runs on its own configured model. */
  tier?: ModelTier;
  /** Why this tier, in plain words, shown on the dashboard. */
  reason: string;
}

const strongWords =
  /\b(refactor\w*|architect\w*|redesign\w*|security|vulnerab\w*|auth\w*|migrat\w*|concurren\w*|race conditions?|deadlocks?|performance|optimi[sz]\w*|debug\w*|investigat\w*|root cause|algorithm\w*)\b/i;
const fastWords =
  /\b(typos?|renam\w*|readme|docs?|documentation|comments?|formatting|lint\w*|bump|changelog|wording|spelling)\b/i;

/** A free first guess at difficulty from the request's wording and length. */
export function guessTier(prompt: string): TierChoice {
  const strong = strongWords.exec(prompt);
  if (strong) return { tier: "strong", reason: `auto: mentions "${strong[0].toLowerCase()}"` };
  if (prompt.length > 1500) return { tier: "strong", reason: "auto: long, detailed request" };
  const fast = fastWords.exec(prompt);
  if (fast && prompt.length < 600) return { tier: "fast", reason: `auto: small change ("${fast[0].toLowerCase()}")` };
  return { tier: "balanced", reason: "auto: ordinary task" };
}

/** Resolve what a caller asked for into the tier stored on the task. */
export function chooseTier(request: TierRequest | undefined, prompt: string, chosenBy: string): TierChoice {
  if (request === "default") return { reason: `the agent's own model, chosen by ${chosenBy}` };
  if (request && request !== "auto") return { tier: request, reason: `chosen by ${chosenBy}` };
  return guessTier(prompt);
}

export interface ModelSelection {
  model?: string;
  effort?: string;
}

/** The model and effort an agent uses for a tier, or undefined for its own default. */
export function modelForTier(adapter: AgentAdapter, tier: ModelTier | undefined): ModelSelection | undefined {
  if (!tier) return undefined;
  const selection = adapter.tiers?.[tier];
  return selection && (selection.model || selection.effort) ? selection : undefined;
}

/** "sonnet", "gpt-6-astra · low effort", or "agent default". */
export function describeModel(selection: ModelSelection | undefined): string {
  if (!selection) return "agent default";
  return [selection.model, selection.effort ? `${selection.effort} effort` : ""].filter(Boolean).join(" · ");
}
