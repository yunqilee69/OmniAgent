import type { ResolvedSessionRuntime } from '@omniagent/core';

/**
 * Context-budget options a resolved runtime hands to `Session`.
 *
 * The budget is derived inside `AgentLoop`, not here: only the loop knows the
 * system prompt and tool disclosure it is about to send, so it subtracts them
 * (plus the output reserve) from the window at every step. This module exists so
 * the Web host and the integration test compose `Session` from the same values
 * instead of copying the wiring — `main.ts` starts a host on import.
 */

/** The parts of a resolved runtime the budget needs. */
export type BudgetSource = Pick<ResolvedSessionRuntime, 'contextWindowTokens' | 'modelDescriptor'>;

export interface ModelBudgetOptions {
  contextWindowTokens?: number;
  outputTokenReserve?: number;
  retainContextTokens?: number;
}

/**
 * Keys are present only when configured: `Session` treats an absent window as
 * "auto-compaction off" and an absent reserve as the window-share fallback, so
 * writing `undefined` would change behaviour instead of describing it.
 */
export function modelBudgetOptions(
  resolved: BudgetSource,
  retainContextTokens?: number,
): ModelBudgetOptions {
  return {
    ...(resolved.contextWindowTokens === undefined
      ? {} : { contextWindowTokens: resolved.contextWindowTokens }),
    // The model's own output ceiling is the honest reserve: the window must hold
    // whatever the provider is allowed to generate next to the prompt.
    ...(resolved.modelDescriptor?.maxTokens === undefined
      ? {} : { outputTokenReserve: resolved.modelDescriptor.maxTokens }),
    ...(retainContextTokens === undefined ? {} : { retainContextTokens }),
  };
}
