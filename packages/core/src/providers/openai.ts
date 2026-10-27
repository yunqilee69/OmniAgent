import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { ContentPart, Message, ToolCall } from '../domain/message';
import { text } from '../domain/message';
import type { ToolSpec } from '../domain/tool';
import type { StopReason } from '../protocol/events';
import type { ModelClient, ModelRequest, ModelResponse, ModelStreamDelta } from './types';

/**
 * OpenAI 兼容 provider。
 *
 * 基础调用完全交给官方 `openai` SDK，不自己拼 HTTP：`baseURL` 一换就能接
 * DeepSeek、OpenRouter、Ollama、vLLM 等所有兼容端点。
 *
 * 这个文件只做一件有信息量的事：把内部 Message / ToolSpec 映射成
 * Chat Completions 的形状，再把响应映射回来。主循环和权限层不知道 provider 是谁。
 */

export interface OpenAIModelOptions {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  /** 审计/日志里显示的名字，默认 openai。 */
  name?: string;
}

export class OpenAIModel implements ModelClient {
  readonly name: string;
  private readonly client: OpenAI;

  constructor(options: OpenAIModelOptions = {}) {
    const apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
    if (!apiKey) {
      throw new Error(
        '缺少 API key：请设置 OPENAI_API_KEY，或在配置的 provider.apiKey 里直接填写。',
      );
    }

    this.name = options.name ?? 'openai';
    this.client = new OpenAI({
      apiKey,
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      ...(options.headers !== undefined ? { defaultHeaders: options.headers } : {}),
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const tools = toOpenAITools(request.tools);
    const completion = await this.client.chat.completions.create(
      {
        model: request.model,
        messages: toOpenAIMessages(request.system, request.messages),
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' as const } : {}),
      },
      { signal: request.signal },
    );

    return toModelResponse(completion);
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamDelta, ModelResponse> {
    const tools = toOpenAITools(request.tools);
    const stream = await this.client.chat.completions.create(
      {
        model: request.model,
        messages: toOpenAIMessages(request.system, request.messages),
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' as const } : {}),
        stream: true,
        // OpenAI 会在最后一个 chunk 带 usage。不支持的兼容端点通常会忽略这个字段。
        stream_options: { include_usage: true },
      },
      { signal: request.signal },
    );

    return yield* toModelStream(stream);
  }
}

/**
 * 消费 Chat Completions 的 chunk 流。
 *
 * 文本片段立即 yield 给上层；tool_call 则按 index 累积——它的 id、name、
 * arguments 都可能被拆到多个 chunk 里，拼完才能得到一个合法的 ToolCall。
 */
export async function* toModelStream(
  chunks: AsyncIterable<ChatCompletionChunk>,
): AsyncGenerator<ModelStreamDelta, ModelResponse> {
  let content = '';
  let finishReason: string | null | undefined;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const chunk of chunks) {
    if (chunk.usage) {
      usage = chunk.usage;
    }

    const choice = chunk.choices[0];
    if (!choice) {
      continue;
    }

    if (choice.delta.content) {
      content += choice.delta.content;
      yield { type: 'text', text: choice.delta.content };
    }

    for (const part of choice.delta.tool_calls ?? []) {
      const call = toolCalls.get(part.index) ?? { id: '', name: '', arguments: '' };
      if (part.id) {
        call.id = part.id;
      }
      if (part.function?.name) {
        call.name += part.function.name;
      }
      if (part.function?.arguments) {
        call.arguments += part.function.arguments;
      }
      toolCalls.set(part.index, call);
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }

  const calls: ToolCall[] = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => ({
      id: call.id || `call_${index + 1}`,
      name: call.name,
      arguments: parseArguments(call.arguments),
      raw: call.arguments,
    }));

  return {
    message: {
      role: 'assistant',
      content: content.length > 0 ? [text(content)] : [],
      toolCalls: calls,
    },
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    },
    stopReason: mapFinishReason(finishReason, calls.length),
  };
}

/** 内部消息 -> Chat Completions messages。 */
export function toOpenAIMessages(
  system: string,
  messages: Message[],
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: 'system', content: system }];

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        out.push({ role: 'system', content: message.content });
        break;

      case 'user':
        out.push({ role: 'user', content: toUserContent(message.content) });
        break;

      case 'assistant': {
        const body = joinText(message.content);
        if (message.toolCalls.length === 0) {
          out.push({ role: 'assistant', content: body });
          break;
        }
        out.push({
          role: 'assistant',
          content: body.length > 0 ? body : null,
          tool_calls: message.toolCalls.map(toOpenAIToolCall),
        });
        break;
      }

      case 'tool':
        // 内部把一批结果放在一条 tool message 里；OpenAI 要求一个 tool_call
        // 对应一条 tool 消息，所以这里展开。
        for (const result of message.results) {
          out.push({
            role: 'tool',
            tool_call_id: result.callId,
            content: result.content,
          });
        }
        break;
    }
  }

  return out;
}

/** 内部工具描述 -> Chat Completions tools。 */
export function toOpenAITools(tools: ToolSpec[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** Chat Completions 响应 -> 内部 ModelResponse。 */
export function toModelResponse(completion: ChatCompletion): ModelResponse {
  const choice = completion.choices[0];
  if (!choice) {
    throw new Error('模型没有返回任何 choice');
  }

  const message = choice.message;
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).flatMap((call) =>
    call.type === 'function'
      ? [
          {
            id: call.id,
            name: call.function.name,
            arguments: parseArguments(call.function.arguments),
            raw: call.function.arguments,
          },
        ]
      : [],
  );

  const content: ContentPart[] = [];
  const body = message.content ?? '';
  if (body.length > 0) {
    content.push(text(body));
  }

  return {
    message: { role: 'assistant', content, toolCalls },
    usage: {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    },
    stopReason: mapFinishReason(choice.finish_reason, toolCalls.length),
  };
}

function toOpenAIToolCall(call: ToolCall) {
  return {
    id: call.id,
    type: 'function' as const,
    function: {
      name: call.name,
      // raw 是模型当时返回的原始串，优先原样回传，避免二次序列化改变格式。
      arguments: call.raw ?? JSON.stringify(call.arguments ?? {}),
    },
  };
}

function toUserContent(parts: ContentPart[]): string | ChatCompletionContentPart[] {
  if (parts.every((part) => part.type === 'text')) {
    return joinText(parts);
  }

  return parts.map((part): ChatCompletionContentPart => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    return {
      type: 'image_url',
      image_url: { url: `data:${part.mediaType};base64,${part.data}` },
    };
  });
}

function joinText(parts: ContentPart[]): string {
  return parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/**
 * 模型偶尔会给出坏 JSON。保留原文并交给工具的 zod 校验，
 * 让它变成一条 ok:false 的 observation 回灌给模型，而不是让整轮崩掉。
 */
function parseArguments(raw: string): unknown {
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalid_json: raw };
  }
}

function mapFinishReason(reason: string | null | undefined, toolCallCount: number): StopReason {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'stop':
    case 'content_filter':
      return 'end_turn';
    default:
      return toolCallCount > 0 ? 'tool_use' : 'end_turn';
  }
}
