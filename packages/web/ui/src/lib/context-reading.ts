/**
 * Reading rules for the composer context meter.
 *
 * The `.../context` endpoint answers two different shapes for the same session:
 * while no turn is running it carries the settled projection of the next
 * request, and while a turn owns the mutable history it answers without one
 * (the runtime refuses to project history it is still rewriting). The meter
 * must therefore treat a projection-less answer as "nothing new to say yet"
 * rather than "no reading exists", or the ring blinks out for the length of
 * every turn.
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
