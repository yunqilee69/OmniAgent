import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import type { SubagentService } from '../../domain/subagent';
import type { Session } from '../../session';
import { ReasoningEffortSchema } from '../../session/model-selection';

export const SUBAGENT_TOOL_NAME = 'subagent';
export const SEND_MESSAGE_TOOL_NAME = 'send_message';
export const LIST_AGENTS_TOOL_NAME = 'list_agents';
export const WAIT_AGENT_TOOL_NAME = 'wait_agent';
export const INTERRUPT_AGENT_TOOL_NAME = 'interrupt_agent';

const StartParams = z.object({
  description: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1),
  cwd: z.string().min(1).optional(),
  provider: z.string().trim().min(1).max(256).optional(),
  model: z.string().trim().min(1).max(256).optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
}).strict();

const SendParams = z.object({
  agent_id: z.string().trim().min(1).max(256),
  message: z.string().trim().min(1),
}).strict();

const AgentIdParams = z.object({
  agent_id: z.string().trim().min(1).max(256),
}).strict();

const WaitParams = z.object({
  agent_id: z.string().trim().min(1).max(256),
  timeout_ms: z.number().int().min(1).max(600_000).optional(),
}).strict();

const EmptyParams = z.object({}).strict();

export function createSubagentTools(session: Session, service: SubagentService): Tool[] {
  return [
    {
      name: SUBAGENT_TOOL_NAME,
      description:
        'Start an independently managed subagent and immediately return its id. '
        + 'The child has its own session, conversation, and tools, and inherits your workspace and permission preset. '
        + 'Continue useful work after starting it; a completion notice starts a new turn when it finishes. '
        + 'Use send_message to steer a running child or continue an idle child, wait_agent to wait for a result, '
        + 'and list_agents to inspect the collaboration tree.',
      parameters: StartParams,
      mutating: false,
      async execute(args, ctx) {
        const parsed = StartParams.parse(args);
        ctx.signal.throwIfAborted();
        const result = await service.start(session, {
          description: parsed.description,
          prompt: parsed.prompt,
          ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
          ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
          ...(parsed.model === undefined ? {} : { model: parsed.model }),
          ...(parsed.reasoning_effort === undefined ? {} : { reasoningEffort: parsed.reasoning_effort }),
        });
        return { content: `Started subagent ${result.id} (${parsed.description}). Continue working; its completion notice will start a new turn.` };
      },
    },
    {
      name: SEND_MESSAGE_TOOL_NAME,
      description:
        'Send a message to another agent in your collaboration tree. A running agent receives it at its next step; '
        + 'an idle agent starts a new turn with it.',
      parameters: SendParams,
      mutating: false,
      async execute(args, ctx) {
        const parsed = SendParams.parse(args);
        ctx.signal.throwIfAborted();
        const result = await service.send(session, parsed.agent_id, parsed.message);
        return { content: `Message delivered to agent ${parsed.agent_id} (${result.messageId}).` };
      },
    },
    {
      name: LIST_AGENTS_TOOL_NAME,
      description:
        'List the other agents in your collaboration tree with their ids, status, relationship, and latest result.',
      parameters: EmptyParams,
      mutating: false,
      async execute(_args, ctx) {
        ctx.signal.throwIfAborted();
        const agents = await service.list(session);
        if (agents.length === 0) return { content: 'No other agents in this collaboration tree.' };
        const lines = agents.map((agent) =>
          `${agent.id} · ${agent.status} · depth ${agent.depth}`
          + (agent.parentId ? ` · parent ${agent.parentId}` : '')
          + (agent.description ? ` · ${agent.description}` : '')
          + (agent.result ? `\n  result: ${agent.result.slice(0, 500)}` : ''));
        return { content: lines.join('\n') };
      },
    },
    {
      name: WAIT_AGENT_TOOL_NAME,
      description:
        'Wait for another agent in your collaboration tree to settle, or return its current status on timeout. '
        + 'Use this only when you have no independent work left.',
      parameters: WaitParams,
      mutating: false,
      async execute(args, ctx) {
        const parsed = WaitParams.parse(args);
        ctx.signal.throwIfAborted();
        const outcome = await service.wait(session, parsed.agent_id, parsed.timeout_ms ?? 120_000, ctx.signal);
        return {
          content: outcome.result
            ? `Agent ${outcome.id}: ${outcome.status}\n${outcome.result}`
            : `Agent ${outcome.id}: ${outcome.status}`,
        };
      },
    },
    {
      name: INTERRUPT_AGENT_TOOL_NAME,
      description:
        'Ask an agent you delegated to stop its current work. The call returns without waiting; '
        + 'a local subagent can be continued later with send_message.',
      parameters: AgentIdParams,
      mutating: false,
      async execute(args, ctx) {
        const parsed = AgentIdParams.parse(args);
        ctx.signal.throwIfAborted();
        const accepted = await service.interrupt(session, parsed.agent_id);
        return {
          content: accepted
            ? `Interrupt requested for agent ${parsed.agent_id}.`
            : `Agent ${parsed.agent_id} is not running.`,
        };
      },
    },
  ];
}
