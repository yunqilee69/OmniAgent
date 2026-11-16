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
import { agentErrorFromUnknown } from '../providers/errors';
import type { AgentError } from '../protocol/events';
import type { ToolSpec } from '../domain/tool';
import type { ToolRegistry } from '../tools/registry';
import { ToolExecutor } from '../exec/executor';
import type { AuditSink } from '../store/audit';
import { digestArgs } from '../store/audit';
import { compactMessages, estimateMessages } from '../context/compaction';
import { contextBreakdown, contextHistoryHash } from '../context/projection';
import { projectImageInput } from '../context/image-input';
import { expandInitCommand } from '../session/init-command';

/**
 * 主循环。
 *
 * 整个 agent 就是这么一个东西：问模型 -> 拿工具调用 -> 过权限 -> 执行 ->
 * 结果塞回 messages -> 再问。所有「高级范式」都是在它周围加东西，
 * 不是替换它。所以这个文件应该保持短，短到你能一眼看完。
 *
 * 它是 async generator 而不是回调：UI 消费事件流，core 不需要知道 UI 存在。
 */

export type PreparedToolCall =
  | { decision: 'deny'; source: string }
  | { decision: 'allow'; source: string; execute: () => Promise<ToolResult> };

export interface AgentLoopDeps {
  model: ModelClient;
  modelId: string;
  imageInput?: boolean;
  system: string | (() => string);
  tools: ToolRegistry;
  /** Optional dynamic disclosure; execution still resolves through {@link tools}. */
  toolSpecs?: () => ToolSpec[];
  /** Drain messages delivered while a turn is running (agent messaging/notices). */
  takeQueuedMessages?: () => Message[];
  /** One-shot manual compaction request, consumed before the next model request. */
  takeForceCompact?: () => boolean;
  permissions: PermissionGate;
  /** Trusted host hook: an allowed call carries its own per-call execution policy. */
  prepareToolCall?: (call: ToolCall, signal: AbortSignal) => Promise<PreparedToolCall>;
  cwd: string;
  sessionId: string;
  /** 防止模型无限循环；到上限就停，并把原因告诉调用方。 */
  maxSteps?: number;
  /**
   * Extra attempts after a retryable model failure. The default is 2.
   * A request that has already streamed text is never retried.
   */
  maxRetries?: number;
  contextWindowTokens?: number;
  retainContextTokens?: number;
  audit?: AuditSink;
}

export function projectCommandInput(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user' || !message.initCommand) return message;
    const content = expandInitCommand(message.content);
    return { role: 'user', content: content ?? message.content };
  });
}

/**
 * Step cap for one turn. It is a last-resort guard against a model that never
 * stops calling tools, not a task budget: real work (long refactors, multi-file
 * edits, research) legitimately needs hundreds of steps, so the default stays
 * far above normal usage and only ends pathological loops.
 */
export const DEFAULT_MAX_STEPS = 300;
/** Extra attempts after the first model request fails for a retryable reason. */
export const DEFAULT_MAX_RETRIES = 2;
export const MAX_MODEL_RETRIES = 8;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;
const RETRY_AFTER_CAP_MS = 30_000;

export function clampMaxRetries(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value)) return DEFAULT_MAX_RETRIES;
  return Math.min(MAX_MODEL_RETRIES, Math.max(0, value));
}

export class AgentLoop {
  constructor(private readonly deps: AgentLoopDeps) {}

  /** 返回值为新的 messages，调用方负责持久化。 */
  async *run(
    history: Message[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent, Message[]> {
    const messages = [...history];
    // The latest user message starts this turn; subsequent queued messages may
    // include user steering that must also survive every compaction in this run.
    const currentUserIndex = messages.findLastIndex((message) => message.role === 'user');
    let protectedIndices = currentUserIndex < 0 ? [] : [currentUserIndex];
    const maxSteps = this.deps.maxSteps ?? DEFAULT_MAX_STEPS;

    for (let step = 0; step < maxSteps; step += 1) {
      if (signal?.aborted) {
        yield { type: 'turn.end', reason: 'interrupted' };
        return messages;
      }

      const queued = this.deps.takeQueuedMessages?.() ?? [];
      if (queued.length > 0) {
        queued.forEach((message, index) => {
          if (message.role === 'user') protectedIndices.push(messages.length + index);
        });
        messages.push(...queued);
      }

      yield { type: 'turn.start', step };

      const forceCompact = this.deps.takeForceCompact?.() === true;
      if (this.deps.contextWindowTokens !== undefined || forceCompact) {
        const beforeTokens = estimateMessages(projectImageInput(projectCommandInput(messages), this.deps.imageInput));
        const maxTokens = forceCompact
          ? Math.max(1, Math.floor(beforeTokens / 2))
          : this.deps.contextWindowTokens;
        if (maxTokens !== undefined) {
          const compacted = await compactMessages(messages, {
            maxTokens,
            protectedIndices,
            project: (history) => projectImageInput(projectCommandInput(history), this.deps.imageInput),
            ...(forceCompact || this.deps.retainContextTokens === undefined
              ? {}
              : { retainTokens: this.deps.retainContextTokens }),
          });
          if (compacted.compacted) {
            protectedIndices = compacted.protectedIndices ?? [];
            messages.splice(0, messages.length, ...compacted.messages);
            yield { type: 'context.compacted', beforeTokens, afterTokens: compacted.afterTokens };
          }
        }
      }

      let assistant: AssistantMessage;
      let stopReason: StopReason;
      try {
        const request = {
          model: this.deps.modelId,
          system: typeof this.deps.system === 'function' ? this.deps.system() : this.deps.system,
          messages: projectImageInput(projectCommandInput(messages), this.deps.imageInput),
          tools: this.deps.toolSpecs ? this.deps.toolSpecs() : this.deps.tools.specs(),
          ...(signal ? { signal } : {}),
        };

        let response: ModelResponse | undefined;
        const requestStartedAt = performance.now();
        // 首 token 延迟只能从流式 delta 里量：非流式请求没有可观测的首包时刻。
        let firstTokenAt: number | null = null;
        const markFirstToken = (): void => {
          if (firstTokenAt === null) firstTokenAt = performance.now();
        };
        const maxRetries = clampMaxRetries(this.deps.maxRetries);
        let attempt = 0;
        while (response === undefined) {
          let streamed = false;
          try {
            if (this.deps.model.stream) {
              response = yield* this.forwardStream(this.deps.model.stream(request), () => {
                streamed = true;
                markFirstToken();
              });
            } else {
              response = await this.deps.model.complete(request);
            }
            if (response === undefined) throw new Error('model stream ended without a response');
          } catch (error) {
            if (signal?.aborted) throw error;
            const agentError = agentErrorFromUnknown(error);
            const canRetry = agentError.retryable === true && !streamed && attempt < maxRetries;
            if (!canRetry) throw error;
            attempt += 1;
            const delayMs = retryDelayMs(attempt, agentError);
            yield { type: 'model.retry', attempt, maxAttempts: maxRetries, delayMs, error: agentError };
            await waitForRetry(delayMs, signal);
          }
        }

        const requestDurationMs = performance.now() - requestStartedAt;

        // Some compatible endpoints synthesize zero when usage is absent. Do not
        // treat that sentinel as a measured prompt size.
        const usage = response.usage;
        const inputTokens = response.contextInputTokens ?? usage?.inputTokens;
        assistant = { ...response.message, requestDurationMs };
        if (firstTokenAt !== null) {
          const elapsed: number = firstTokenAt - requestStartedAt;
          const firstTokenDurationMs = Math.min(requestDurationMs, Math.max(0, elapsed));
          if (firstTokenDurationMs > 0) assistant.firstTokenDurationMs = firstTokenDurationMs;
        }
        if (Number.isSafeInteger(inputTokens) && inputTokens >= 0
          && Number.isSafeInteger(usage?.outputTokens) && usage.outputTokens >= 0) {
          const cachedInputTokens = usage.cachedInputTokens;
          assistant.usage = { inputTokens, outputTokens: usage.outputTokens,
            ...(Number.isSafeInteger(cachedInputTokens) && cachedInputTokens! >= 0 && cachedInputTokens! <= inputTokens
              ? { cachedInputTokens } : {}) };
        } else {
          delete assistant.usage;
        }
        if (assistant.usage && inputTokens > 0) {
          assistant.contextSample = {
            provider: this.deps.model.name, model: request.model,
            historyHash: contextHistoryHash(request.messages),
            ...contextBreakdown(request.system, request.tools, request.messages),
          };
        } else {
          delete assistant.contextSample;
        }
        stopReason = response.stopReason;
      } catch (error) {
        // 中断不是错误：UI 主动 abort 时模型流会抛 AbortError，别报成 error 事件。
        if (signal?.aborted) {
          yield { type: 'turn.end', reason: 'interrupted' };
          return messages;
        }
        yield { type: 'error', error: agentErrorFromUnknown(error) };
        yield { type: 'turn.end', reason: 'error' };
        return messages;
      }

      messages.push(assistant);
      yield { type: 'assistant.message', message: assistant };

      if (assistant.toolCalls.length === 0 || stopReason === 'max_tokens') {
        yield { type: 'turn.end', reason: stopReason };
        return messages;
      }

      const results: ToolResult[] = [];
      const callSignal = signal ?? new AbortController().signal;
      const executor = new ToolExecutor(this.deps.tools, {
        cwd: this.deps.cwd,
        signal: callSignal,
      });

      for (const call of assistant.toolCalls) {
        if (callSignal.aborted) {
          yield { type: 'turn.end', reason: 'interrupted' };
          return messages;
        }
        yield { type: 'tool.call', call };

        if (callSignal.aborted) {
          yield { type: 'turn.end', reason: 'interrupted' };
          return messages;
        }
        const prepared = this.deps.prepareToolCall
          ? await this.deps.prepareToolCall(call, callSignal)
          : undefined;
        const permission = prepared ?? await this.deps.permissions.check(call);
        if (callSignal.aborted) {
          yield { type: 'turn.end', reason: 'interrupted' };
          return messages;
        }
        yield {
          type: 'permission.decided',
          callId: call.id,
          decision: permission.decision,
          source: permission.source,
        };

        if (callSignal.aborted) {
          yield { type: 'turn.end', reason: 'interrupted' };
          return messages;
        }
        const execution = permission.decision === 'allow'
          ? prepared?.decision === 'allow'
            ? prepared.execute()
            : executor.execute(call)
          : Promise.resolve(deniedResult(call, permission.source));
        const result = await Promise.race([
          execution,
          abortResult(call, callSignal),
        ]);

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
   * provider 只 yield 文本/思考增量；完整的 assistant 消息和 tool calls 由流
   * 结束时的 return 值带回。这样 UI 可以边收边画，循环后续逻辑完全不用改。
   */
  private async *forwardStream(
    stream: AsyncGenerator<ModelStreamDelta, ModelResponse>,
    onFirstDelta: () => void,
  ): AsyncGenerator<AgentEvent, ModelResponse> {
    let next = await stream.next();
    let announced = false;
    while (!next.done) {
      if (!announced) {
        announced = true;
        onFirstDelta();
      }
      if (next.value.type === 'text') {
        yield { type: 'assistant.delta', text: next.value.text };
      } else {
        yield { type: 'assistant.reasoning.delta', text: next.value.text };
      }
      next = await stream.next();
    }
    return next.value;
  }
}

function retryDelayMs(attempt: number, error: AgentError): number {
  const advertised = error.retryAfterMs;
  if (advertised !== undefined && Number.isFinite(advertised) && advertised > 0) {
    return Math.min(RETRY_AFTER_CAP_MS, Math.floor(advertised));
  }
  const exponential = RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1));
  const capped = Math.min(RETRY_MAX_DELAY_MS, exponential);
  const jitter = Math.floor(Math.random() * Math.min(250, capped / 5));
  return capped + jitter;
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const onAbort = (): void => finish(signal?.reason ?? new Error('The operation was aborted'));
    function finish(error?: unknown): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error === undefined) resolve();
      else reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (signal?.aborted) {
      finish(signal.reason);
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A stop request ends the wait. The underlying call may still finish later. */
function abortResult(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
  if (signal.aborted) return Promise.resolve(interruptedResult(call));
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(interruptedResult(call)), { once: true });
  });
}

function interruptedResult(call: ToolCall): ToolResult {
  return {
    callId: call.id,
    name: call.name,
    ok: false,
    content: 'Tool execution was interrupted before it finished. Do not assume it ran.',
    truncated: false,
  };
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
