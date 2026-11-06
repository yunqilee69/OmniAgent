import type { AgentDefinition } from './types';

/** Model-facing catalog for agents that can be started as subagents. */
export function renderAgentCatalog(agents: readonly AgentDefinition[]): string {
  const available = agents.filter((agent) =>
    agent.usage === 'subagent' || agent.usage === 'both');
  if (available.length === 0) return '';
  return [
    '<available_agents>',
    ...available.map((agent) =>
      `- \`${agent.id}\`: ${agent.description.replace(/\s+/g, ' ').trim() || agent.name} (role: ${agent.role})`),
    '</available_agents>',
    'When delegating, pass one of these ids as the `agent` argument of the `subagent` tool.',
  ].join('\n');
}
