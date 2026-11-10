import type { AssistantMessage, Message, Usage } from '../domain/message';
import type { ToolSpec } from '../domain/tool';
import type { StopReason } from '../protocol/events';

/**
 * 模型客户端契约。
 *
 * 刻意不用 AI SDK 的高层抽象：这一层薄到能看清 tool_call 的原始形状，
 * 换 provider 时你才真正知道各家差在哪。
 *
 * complete() 是必须实现的基线；stream() 可选，主循环发现它存在就走流式，
 * 否则自动退化到 complete()。
 */

export interface ModelRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  /** Optional output-token ceiling; auxiliary requests such as titles use it. */
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ModelResponse {
  message: AssistantMessage;
  usage: Usage;
  /** Total prompt occupancy when provider usage separates cached input. */
  contextInputTokens?: number;
  stopReason: StopReason;
}

/**
 * 流式增量。
 *
 * reasoning 是模型的思考内容，text 是给用户看的正文；两者分开，UI 才能分别
 * 渲染。tool_call 的分片不往外抛：它在 provider 内部累积成完整的 ToolCall，
 * 等流结束随 ModelResponse 一起返回。
 */
export type ModelStreamDelta =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string };

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
