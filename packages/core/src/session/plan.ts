export const PLAN_MODE_EVENT = 'plan/mode';

export interface PlanProjection {
  active: boolean;
}

/** The last well-formed mode event wins; malformed or absent state is inactive. */
export function projectPlanMode(events: readonly { type: string; data: unknown }[]): PlanProjection {
  let active = false;
  for (const event of events) {
    if (event.type !== PLAN_MODE_EVENT) continue;
    if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) continue;
    const value = (event.data as Record<string, unknown>).active;
    if (typeof value === 'boolean') active = value;
  }
  return { active };
}

export function createPlanModeEvent(active: boolean): { type: typeof PLAN_MODE_EVENT; data: { active: boolean } } {
  if (typeof active !== 'boolean') throw new TypeError('Plan mode state must be a boolean');
  return { type: PLAN_MODE_EVENT, data: { active } };
}

export const PLAN_MODE_GUIDANCE = `You are in plan mode.

- Investigate the workspace and gather the facts needed for a concrete plan.
- Do not edit or write files while in plan mode.
- Decide the implementation yourself; do not ask the user to approve individual investigation steps.
- When the plan is ready, call exit_plan_mode with the complete Markdown plan, starting with a # heading.
- If the user keeps planning, revise the plan using their feedback and present it again.`;
