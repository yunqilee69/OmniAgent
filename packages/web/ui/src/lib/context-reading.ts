/**
 * Reading rules for the composer context meter.
 *
 * The host publishes the reading, and any single publication may arrive without
 * a projection: the session detail response carries one only when the runtime
 * can replay the history, and a running turn pushes `run.context` frames for a
 * host that holds the matching live Session — a turn owned by another host
 * pushes ones without a projection. The meter must therefore treat a
 * projection-less payload as "no new reading this time" rather than "no reading
 * exists" — `carryProjection` keeps the last settled projection in that case —
 * or the ring blinks out for the length of every turn.
 */
import type { ContextEstimate } from './wire.ts';

/** The capacity a percentage is taken against: the budget the session actually
 * compacts against (config override, else the model's window), falling back to
 * the model descriptor when the runtime could not resolve a budget at all. */
export function contextCapacity(value: ContextEstimate): number | undefined {
  for (const tokens of [value.window?.tokens, value.modelWindow]) {
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) return tokens;
  }
  return undefined;
}

/**
 * Keep the last settled projection when the runtime cannot report one (a turn
 * is in flight). Everything else in the answer — the model window, the resolved
 * budget — is fresher than what we hold and is adopted as-is.
 */
export function carryProjection(previous: ContextEstimate | undefined, next: ContextEstimate): ContextEstimate {
  if (next.projection !== undefined || previous?.projection === undefined) return next;
  return { ...next, projection: previous.projection };
}

/**
 * Marker the localized occupancy sentence is split on, so the panel headline
 * keeps the reading in its own tone while each locale still owns the word order
 * (`45% of context used` / `上下文已用 45%`).
 */
export const READING_SLOT = '\0';

/**
 * Split a localized occupancy sentence around the reading. The placeholder
 * stands for the whole reading — unit included — so a template that appends its
 * own `%` would render a doubled sign (`7%%`); the sentence template carries no
 * literal percent.
 */
export function splitReadingSentence(sentence: string): [before: string, after: string] {
  const [before = '', after = ''] = sentence.split(READING_SLOT).map((part) => part.trim());
  return [before, after];
}

export interface ContextOccupancy {
  /** Share of the budget in use; `0` until a settled projection with a known budget lands. */
  percent: number;
  /** Whether the breakdown comes from a settled projection rather than the placeholder. */
  settled: boolean;
  projection?: ContextEstimate['projection'];
  capacity?: number;
}

/**
 * The ring never blanks: a session whose first turn is still running has
 * nothing settled to show yet, so it reads 0% and the panel says the figures
 * arrive when the turn finishes. A settled projection — including one carried
 * across a turn — wins over the placeholder. Without a known budget there is no
 * share to draw, so the ring stays at 0% while the breakdown is still listed.
 */
export function contextOccupancy(value: ContextEstimate | null): ContextOccupancy {
  const projection = value?.projection;
  const capacity = value === null ? undefined : contextCapacity(value);
  const percent = projection === undefined || capacity === undefined
    ? 0
    : Math.min(100, Math.round(projection.projectedTokens / capacity * 100));
  return {
    percent,
    settled: projection !== undefined,
    ...(projection === undefined ? {} : { projection }),
    ...(capacity === undefined ? {} : { capacity }),
  };
}
