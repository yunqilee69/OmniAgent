import type { AssistantMessage, Message, Usage } from '../domain/message';
import type { ToolSpec } from '../domain/tool';
import type { StopReason } from '../protocol/events';

/**
 * 模型客户端契约。
 *
 * 刻意不用 AI SDK 的高层抽象：这一层薄到能看清 tool_call 的原始形状，
 * 换 provider 时你才真正知道各家差在哪。M1 只有 complete()，流式以后加。
 */

export interface ModelRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface ModelResponse {
  message: AssistantMessage;
  usage: Usage;
  stopReason: StopReason;
}

/**
 * 流式增量。
 *
 * 目前只有文本。tool_call 的分片不往外抛：它在 provider 内部累积成完整的
 * ToolCall，等流结束随 ModelResponse 一起返回。UI 需要的是「正在说话」，
 * 不是「参数拼到第几个字符」。
 */
export type ModelStreamDelta = { type: 'text'; text: string };

export interface ModelClient {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;

  /**
   * 可选流式接口。实现它的 provider 会在生成过程中 yield 增量，
   * 最后 return 完整的 ModelResponse。没实现的 provider 走 complete()，
   * 主循环会自动退化，不产生 assistant.delta 事件。
   */
  stream?(request: ModelRequest): AsyncGenerator<ModelStreamDelta, ModelResponse>;
}
