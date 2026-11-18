import { z } from 'zod';
import { ModelBindingSchema } from './model-binding';
import type { ModelBinding } from './model-binding';

/** Durable selection of the immutable composition a root session started with. */
export const MODE_SELECTION_EVENT = 'mode/selected';
export const MODE_SELECTION_VERSION = 1;
export const TEAM_MODE_SELECTION_VERSION = 2;

const nonEmpty = z.string().trim().min(1).max(256);

export const ModeSelectorSchema = z.union([
  z.literal('*'),
  z.array(nonEmpty).max(256),
]);

export type ModeSelector = z.infer<typeof ModeSelectorSchema>;

const TeamMemberSnapshotSchema = z.strictObject({
  id: nonEmpty,
  name: nonEmpty,
  agent: nonEmpty,
  model: ModelBindingSchema,
  prompt: z.string().max(20_000),
  tools: ModeSelectorSchema,
  skills: ModeSelectorSchema,
});

const TeamPolicySnapshotSchema = z.strictObject({
  maxActive: z.number().int().min(1).max(8),
  maxDepth: z.literal(1),
  maxSteps: z.number().int().min(1).max(500),
  failure: z.enum(['stop', 'continue']),
  allowPlan: z.boolean(),
  allowGoal: z.boolean(),
});

const SingleModeSelectionSchema = z.strictObject({
  version: z.literal(MODE_SELECTION_VERSION),
  mode: nonEmpty,
  agent: nonEmpty,
  model: ModelBindingSchema,
  tools: ModeSelectorSchema,
  skills: ModeSelectorSchema,
});

const TeamModeSelectionSchema = z.strictObject({
  version: z.literal(TEAM_MODE_SELECTION_VERSION),
  type: z.literal('team'),
  mode: nonEmpty,
  agent: nonEmpty,
  model: ModelBindingSchema,
  tools: ModeSelectorSchema,
  skills: ModeSelectorSchema,
  members: z.array(TeamMemberSnapshotSchema).min(1).max(8),
  policy: TeamPolicySnapshotSchema,
});

export const ModeSelectionSchema = z.union([SingleModeSelectionSchema, TeamModeSelectionSchema]);
export type ModeSelection = z.infer<typeof ModeSelectionSchema>;
export type TeamMemberSnapshot = z.infer<typeof TeamMemberSnapshotSchema>;

export type ModeSelectionProjection =
  | { status: 'selected'; selection: ModeSelection }
  | { status: 'none' | 'invalid'; selection: null };

export function createModeSelectionEvent(
  selection: ModeSelection,
): { type: typeof MODE_SELECTION_EVENT; data: ModeSelection } {
  return {
    type: MODE_SELECTION_EVENT,
    data: ModeSelectionSchema.parse(selection),
  };
}

export function projectModeSelection(
  events: readonly { type: string; data: unknown }[],
): ModeSelectionProjection {
  let projection: ModeSelectionProjection = { status: 'none', selection: null };
  for (const event of events) {
    if (event.type !== MODE_SELECTION_EVENT) continue;
    const parsed = ModeSelectionSchema.safeParse(event.data);
    projection = parsed.success
      ? { status: 'selected', selection: parsed.data }
      : { status: 'invalid', selection: null };
  }
  return projection;
}

export function hasModeSelection(events: readonly { type: string; data: unknown }[]): boolean {
  return events.some((event) => event.type === MODE_SELECTION_EVENT);
}
