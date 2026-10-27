import type {
  AssistantMessage,
  Message,
  ToolCall,
  ToolResult,
} from '../domain/message';
import type { AgentEvent, StopReason } from '../protocol/events';
import type { PermissionGate } from '../protocol/permission';
import type {
  ModelClient,
  ModelResponse,
  ModelStreamDelta,
} from '../providers/types';
import type { ToolRegistry } from '../tools/registry';
import { ToolExecutor } from '../exec/executor';
import type { AuditSink } from '../store/audit';
import { digestArgs } from '../store/audit';

/**
 * 主循环。
 *
 * 整个 agent 就是这么一个东西：问模型 -> 拿工具调用 -> 过权限 -> 执行 ->
 * 结果塞回 messages -> 再问。所有「高级范式」都是在它周围加东西，
 * 不是替换它。所以这个文件应该保持短，短到你能一眼看完。
 *
 * 它是 async generator 而不是回调：UI 消费事件流，core 不需要知道 UI 存在。
 */

export interface AgentLoopDeps {
  model: ModelClient;
  modelId: string;
  system: string;
  tools: ToolRegistry;
  permissions: PermissionGate;
  cwd: string;
  sessionId: string;
  /** 防止模型无限循环；到上限就停，并把原因告诉调用方。 */
  maxSteps?: number;
  audit?: AuditSink;
}

export const DEFAULT_MAX_STEPS = 25;

export class AgentLoop {
  constructor(private readonly deps: AgentLoopDeps) {}

  /** 返回值为新的 messages，调用方负责持久化。 */
  async *run(
    history: Message[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent, Message[]> {
    const messages = [...history];
    const maxSteps = this.deps.maxSteps ?? DEFAULT_MAX_STEPS;

    for (let step = 0; step < maxSteps; step += 1) {
      if (signal?.aborted) {
        yield { type: 'turn.end', reason: 'interrupted' };
        return messages;
      }

      yield { type: 'turn.start', step };

      let assistant: AssistantMessage;
      let stopReason: StopReason;
      try {
        const request = {
          model: this.deps.modelId,
          system: this.deps.system,
          messages,
          tools: this.deps.tools.specs(),
          ...(signal ? { signal } : {}),
        };

        let response: ModelResponse;
        if (this.deps.model.stream) {
          response = yield* this.forwardStream(this.deps.model.stream(request));
        } else {
          response = await this.deps.model.complete(request);
        }

        assistant = response.message;
        stopReason = response.stopReason;
      } catch (error) {
        // 中断不是错误：UI 主动 abort 时模型流会抛 AbortError，别报成 error 事件。
        if (signal?.aborted) {
          yield { type: 'turn.end', reason: 'interrupted' };
          return messages;
        }
        yield { type: 'error', error: { message: messageOf(error) } };
        yield { type: 'turn.end', reason: 'error' };
        return messages;
      }

      messages.push(assistant);
      yield { type: 'assistant.message', message: assistant };

      if (assistant.toolCalls.length === 0) {
        yield { type: 'turn.end', reason: stopReason };
        return messages;
      }

      const results: ToolResult[] = [];
      const executor = new ToolExecutor(this.deps.tools, {
        cwd: this.deps.cwd,
        signal: signal ?? new AbortController().signal,
      });

      for (const call of assistant.toolCalls) {
        yield { type: 'tool.call', call };

        const permission = await this.deps.permissions.check(call);
        yield {
          type: 'permission.decided',
          callId: call.id,
          decision: permission.decision,
          source: permission.source,
        };

        const result =
          permission.decision === 'allow'
            ? await executor.execute(call)
            : deniedResult(call, permission.source);

        results.push(result);
        yield { type: 'tool.result', result };

        await this.deps.audit?.({
          ts: new Date().toISOString(),
          sessionId: this.deps.sessionId,
          step,
          tool: call.name,
          callId: call.id,
          argsDigest: digestArgs(call.arguments),
          decision: permission.decision,
          source: permission.source,
          ok: result.ok,
          ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
        });
      }

      messages.push({ role: 'tool', results });
    }

    yield { type: 'turn.end', reason: 'max_steps' };
    return messages;
  }

  /**
   * 把 provider 的流式片段转成 UI 事件。
   *
   * provider 只 yield 文本增量；完整的 assistant 消息和 tool calls 由流结束时
   * 的 return 值带回。这样 UI 可以边收边画，循环后续逻辑完全不用改。
   */
  private async *forwardStream(
    stream: AsyncGenerator<ModelStreamDelta, ModelResponse>,
  ): AsyncGenerator<AgentEvent, ModelResponse> {
    let next = await stream.next();
    while (!next.done) {
      if (next.value.type === 'text') {
        yield { type: 'assistant.delta', text: next.value.text };
      }
      next = await stream.next();
    }
    return next.value;
  }
}

/** 被拒也是一种 observation：告诉模型为什么不行，它才有机会换个做法。 */
function deniedResult(call: ToolCall, source: string): ToolResult {
  return {
    callId: call.id,
    name: call.name,
    ok: false,
    content: `调用被权限策略拒绝（${source}）。不要重试同一调用，换一种方式或向用户说明。`,
    truncated: false,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
