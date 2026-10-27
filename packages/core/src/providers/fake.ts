import type { AssistantMessage, Usage } from '../domain/message';
import { assistantText, text } from '../domain/message';
import type { StopReason } from '../protocol/events';
import type { ModelClient, ModelRequest, ModelResponse, ModelStreamDelta } from './types';

/**
 * 剧本化假模型。
 *
 * 这是整个项目性价比最高的一个文件：主循环的语义（工具调用、结果回灌、
 * 停止条件、权限拒绝）全都能零 token 单测。真模型只用来验证「提示词好不好」，
 * 不用来验证「循环写对没有」。
 */

export interface FakeStep {
  message: AssistantMessage;
  usage?: Usage;
  stopReason?: StopReason;
}

export function textResponse(body: string): FakeStep {
  return {
    message: { role: 'assistant', content: [text(body)], toolCalls: [] },
    stopReason: 'end_turn',
  };
}

export function toolCallResponse(
  calls: Array<{ id?: string; name: string; args: unknown }>,
  body = '',
): FakeStep {
  return {
    message: {
      role: 'assistant',
      content: body ? [text(body)] : [],
      toolCalls: calls.map((call, index) => ({
        id: call.id ?? `call_${index + 1}`,
        name: call.name,
        arguments: call.args,
      })),
    },
    stopReason: 'tool_use',
  };
}

export class FakeModel implements ModelClient {
  readonly name = 'fake';
  private cursor = 0;
  /** 记录每次请求，方便断言「我们把什么喂给了模型」。 */
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly steps: FakeStep[],
    private readonly options: { onExhausted?: FakeStep } = {},
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    // 快照 messages：主循环会继续往同一个数组里 push，如果直接存引用，
    // 事后断言时看到的就是「最终状态」而不是「当时喂进去的东西」。
    this.requests.push({ ...request, messages: [...request.messages] });
    const step = this.steps[this.cursor] ?? this.options.onExhausted;
    this.cursor += 1;
    if (!step) {
      throw new Error(
        `FakeModel 剧本用完了（第 ${this.cursor} 次调用）。补一个 FakeStep，或在测试里断言调用次数。`,
      );
    }
    return {
      message: step.message,
      usage: step.usage ?? { inputTokens: 0, outputTokens: 0 },
      stopReason: step.stopReason ?? 'end_turn',
    };
  }

  /** 和真 provider 走同一条流式路径，让循环的 delta 转发也能被零成本测到。 */
  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamDelta, ModelResponse> {
    const response = await this.complete(request);
    for (const chunk of splitText(assistantText(response.message))) {
      yield { type: 'text', text: chunk };
    }
    return response;
  }
}

/** 按 code point 切块，避免把 emoji 的代理对劈开。 */
function splitText(value: string, size = 8): string[] {
  const chars = Array.from(value);
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += size) {
    chunks.push(chars.slice(index, index + size).join(''));
  }
  return chunks;
}
