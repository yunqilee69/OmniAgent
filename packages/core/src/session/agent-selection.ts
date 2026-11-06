import { z } from 'zod';

export const AGENT_SELECTION_EVENT = 'agent/selected';
export const AGENT_SELECTION_VERSION = 1;

export const AGENT_USAGES = ['primary', 'subagent', 'both'] as const;
export const AgentUsageSchema = z.enum(AGENT_USAGES);
export type AgentUsage = z.infer<typeof AgentUsageSchema>;

const nonEmpty = z.string().trim().min(1).max(128);

export const AgentSelectionSchema = z.strictObject({
  version: z.literal(AGENT_SELECTION_VERSION),
  agent: nonEmpty,
});
export type AgentSelection = z.infer<typeof AgentSelectionSchema>;

export type AgentSelectionProjection =
  | { status: 'selected'; agent: string }
  | { status: 'legacy' | 'invalid'; agent: null };

export function createAgentSelectionEvent(agent: string): { type: typeof AGENT_SELECTION_EVENT; data: AgentSelection } {
  return {
    type: AGENT_SELECTION_EVENT,
    data: AgentSelectionSchema.parse({ version: AGENT_SELECTION_VERSION, agent }),
  };
}

export function projectAgentSelection(
  events: readonly { type: string; data: unknown }[],
): AgentSelectionProjection {
  let projection: AgentSelectionProjection = { status: 'legacy', agent: null };
  for (const event of events) {
    if (event.type !== AGENT_SELECTION_EVENT) continue;
    const parsed = AgentSelectionSchema.safeParse(event.data);
    projection = parsed.success
      ? { status: 'selected', agent: parsed.data.agent }
      : { status: 'invalid', agent: null };
  }
  return projection;
}

export function createAgentSwitch(
  projection: AgentSelectionProjection,
  target: unknown,
): { type: typeof AGENT_SELECTION_EVENT; data: AgentSelection } | undefined {
  const selection = AgentSelectionSchema.parse(target);
  if (projection.status === 'selected' && projection.agent === selection.agent) return undefined;
  return createAgentSelectionEvent(selection.agent);
}

export function usageAllowsRoot(usage: AgentUsage): boolean {
  return usage === 'primary' || usage === 'both';
}

export function usageAllowsSubagent(usage: AgentUsage): boolean {
  return usage === 'subagent' || usage === 'both';
}
