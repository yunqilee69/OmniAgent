import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import type { SubagentListEntry, SubagentService } from '../../domain/subagent';
import type { Session } from '../../session';
import { ReasoningEffortSchema } from '../../protocol/reasoning';

export const SUBAGENT_TOOL_NAME = 'subagent';
export const SEND_MESSAGE_TOOL_NAME = 'send_message';
export const LIST_AGENTS_TOOL_NAME = 'list_agents';
export const WAIT_AGENT_TOOL_NAME = 'wait_agent';
export const INTERRUPT_AGENT_TOOL_NAME = 'interrupt_agent';

const StartParams = z.object({
  description: z.string().trim().min(1).max(200).describe(
    'A short (3-5 word) description of the delegated task, for display. '
    + "Use the language of the user's current request.",
  ),
  prompt: z.string().trim().min(1).describe(
    'The complete, self-contained task for the subagent. It does not share this '
    + "conversation's context, so include everything it needs.",
  ),
  cwd: z.string().min(1).optional().describe(
    'Initial child working directory. Relative paths use your current directory; omitted inherits it. '
    + 'Later directory changes in either agent are independent.',
  ),
  agent: z.string().trim().min(1).max(128).optional().describe(
    'Configured subagent id. Omit to inherit your agent when it is usable as a subagent.',
  ),
  role: z.string().trim().min(1).max(128).optional().describe(
    'Optional model role override for the child; cannot be combined with provider/model.',
  ),
  provider: z.string().trim().min(1).max(256).optional().describe(
    'Child LLM provider id; requires `model`.',
  ),
  model: z.string().trim().min(1).max(256).optional().describe(
    'Model id within that provider; requires `provider`.',
  ),
  reasoning_effort: ReasoningEffortSchema.optional().describe(
    'Reasoning effort id; requires `provider` and `model`.',
  ),
}).strict();

const SendParams = z.object({
  agent_id: z.string().trim().min(1).max(256).describe(
    'The agent id of another member of your subagent tree, as shown by list_agents.',
  ),
  message: z.string().trim().min(1).describe('The message to deliver to the agent.'),
}).strict();

const AgentIdParams = z.object({
  agent_id: z.string().trim().min(1).max(256).describe(
    'The id of an agent created under you: your direct child or a deeper descendant.',
  ),
}).strict();

const WaitParams = z.object({
  timeout_ms: z.number().describe(
    'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.',
  ).optional(),
}).strict();

const EmptyParams = z.object({}).strict();

function renderList(entries: readonly SubagentListEntry[]): string {
  return entries.map((entry) => {
    if (entry.kind === 'root') return `${entry.id} [${entry.status}] — root agent`;
    const at = ` parent=${String(entry.parent)} depth=${String(entry.depth)}`;
    return entry.kind === 'diagnostic'
      ? `${entry.id} [diagnostic: ${entry.reason}]${at}`
      : `${entry.id} [${entry.status}]${at} — ${entry.label}`;
  }).join('\n');
}

export function createSubagentTools(session: Session, service: SubagentService): Tool[] {
  return [
    {
      name: SUBAGENT_TOOL_NAME,
      description:
        'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
        + 'to offload focused, independent work — research, a scoped implementation, an analysis — '
        + "so it does not consume this conversation's context. The subagent returns its result, not its "
        + 'intermediate steps. This tool starts an independently managed subagent and immediately returns '
        + 'its id. If you are still online when it finishes, the runtime automatically delivers its '
        + 'completion notice. Use `send_message` to steer it while running or continue its conversation '
        + 'after it finishes. Pass `agent` to choose a configured subagent; omit it to inherit your agent.',
      parameters: StartParams,
      mutating: false,
      async execute(args, ctx) {
        const parsed = StartParams.parse(args);
        ctx.signal.throwIfAborted();
        const result = await service.start(session, {
          description: parsed.description,
          prompt: parsed.prompt,
          ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
          ...(parsed.agent === undefined ? {} : { agent: parsed.agent }),
          ...(parsed.role === undefined ? {} : { role: parsed.role }),
          ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
          ...(parsed.model === undefined ? {} : { model: parsed.model }),
          ...(parsed.reasoning_effort === undefined ? {} : { reasoningEffort: parsed.reasoning_effort }),
        });
        return { content: `started subagent ${result.id}` };
      },
    },
    {
      name: SEND_MESSAGE_TOOL_NAME,
      description:
        'Send a message to an agent. A working agent receives it at its next step; an idle agent starts a new turn with it. '
        + 'Returns delivery confirmation.',
      parameters: SendParams,
      mutating: false,
      async execute(args, ctx) {
        const parsed = SendParams.parse(args);
        ctx.signal.throwIfAborted();
        await service.send(session, parsed.agent_id, parsed.message);
        return { content: `message delivered to agent ${parsed.agent_id}` };
      },
    },
    {
      name: LIST_AGENTS_TOOL_NAME,
      description:
        'List your entire subagent tree: the root agent and all reachable continuable descendants, including yourself. '
        + 'Rows carry ids, descriptions, and status; descendant rows carry parent ids and depth from the root. '
        + 'You can message any other agent in the subagent tree listed as running or inactive. '
        + 'running means it is working; inactive means no turn is executing; it does not indicate task completion, success, or failure. '
        + 'While you remain active, you will be notified when a direct child finishes; there is no need to keep checking its status. '
        + 'Use send_message to continue the conversation.',
      parameters: EmptyParams,
      mutating: false,
      async execute(_args, ctx) {
        ctx.signal.throwIfAborted();
        return { content: renderList(await service.list(session)) };
      },
    },
    {
      name: WAIT_AGENT_TOOL_NAME,
      description:
        'Wait for input at your next step, including agent messages, completion notifications, and user steering. '
        + 'Returns immediately when that input is already pending.',
      parameters: WaitParams,
      mutating: false,
      async execute(args, ctx) {
        const parsed = WaitParams.parse(args);
        const timeoutMs = parsed.timeout_ms ?? 30_000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
          throw new Error('timeout_ms must be an integer from 10000 through 3600000');
        }
        ctx.signal.throwIfAborted();
        const outcome = await service.waitForInput(session, timeoutMs, ctx.signal);
        return { content: JSON.stringify(outcome) };
      },
    },
    {
      name: INTERRUPT_AGENT_TOOL_NAME,
      description:
        'Ask a subagent to stop its current work. This call returns without waiting for it to stop. '
        + 'You can continue a local subagent\'s conversation later with send_message. '
        + 'External executions stop permanently and cannot receive follow-ups. Subagents it started will keep running.',
      parameters: AgentIdParams,
      mutating: false,
      async execute(args, ctx) {
        const parsed = AgentIdParams.parse(args);
        ctx.signal.throwIfAborted();
        await service.interrupt(session, parsed.agent_id);
        return { content: `interrupt requested for agent ${parsed.agent_id}` };
      },
    },
  ];
}
