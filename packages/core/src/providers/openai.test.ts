import { describe, expect, it, vi } from 'vitest';
import type {
  ChatCompletion,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions';
import { ConfigSchema } from '../config/load';
import type { AssistantMessage, ToolMessage, UserMessage } from '../domain/message';
import { text } from '../domain/message';
import { createConfiguredModel } from './create';
import {
  toModelResponse,
  toModelStream,
  toOpenAIMessages,
  toOpenAITools,
} from './openai';

const user: UserMessage = { role: 'user', content: [text('读一下 a.txt')] };

const assistantWithTool: AssistantMessage = {
  role: 'assistant',
  content: [],
  toolCalls: [
    { id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' }, raw: '{"path":"a.txt"}' },
  ],
};

const tools: ToolMessage = {
  role: 'tool',
  results: [
    { callId: 'call_1', name: 'read_file', ok: true, content: 'AAA', truncated: false },
    { callId: 'call_2', name: 'list_dir', ok: false, content: 'denied', truncated: false },
  ],
};

function completion(overrides: {
  content?: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';
}): ChatCompletion {
  return {
    id: 'chatcmpl_1',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        finish_reason: overrides.finishReason ?? 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content: overrides.content ?? null,
          refusal: null,
          ...(overrides.toolCalls
            ? {
                tool_calls: overrides.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  } as ChatCompletion;
}

function chunk(
  delta: ChatCompletionChunk.Choice['delta'],
  finishReason: ChatCompletionChunk.Choice['finish_reason'] = null,
): ChatCompletionChunk {
  return {
    id: 'chatcmpl_1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  } as ChatCompletionChunk;
}

async function* asyncItems<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

describe('toOpenAIMessages', () => {
  it('把 system 放在最前，并保留 user / assistant / tool 的顺序', () => {
    const messages = toOpenAIMessages('你是助手', [user, assistantWithTool, tools]);

    expect(messages[0]).toEqual({ role: 'system', content: '你是助手' });
    expect(messages[1]).toEqual({ role: 'user', content: '读一下 a.txt' });
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
        },
      ],
    });
  });

  it('把一条 tool message 里的多个结果展开成多条 tool 消息', () => {
    const messages = toOpenAIMessages('sys', [tools]);
    const toolMessages = messages.filter((message) => message.role === 'tool');

    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]).toMatchObject({ tool_call_id: 'call_1', content: 'AAA' });
    expect(toolMessages[1]).toMatchObject({ tool_call_id: 'call_2', content: 'denied' });
  });

  it('图片 part 转成 data URI', () => {
    const withImage: UserMessage = {
      role: 'user',
      content: [
        text('看图'),
        { type: 'image', mediaType: 'image/png', data: 'QUJD' },
      ],
    };

    const messages = toOpenAIMessages('sys', [withImage]);

    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      ],
    });
  });

  it('没有 raw 时回退到 JSON.stringify', () => {
    const withoutRaw: AssistantMessage = {
      ...assistantWithTool,
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } }],
    };

    const messages = toOpenAIMessages('sys', [withoutRaw]);
    const assistant = messages[1] as { tool_calls: Array<{ function: { arguments: string } }> };

    expect(assistant.tool_calls[0]?.function.arguments).toBe('{"path":"a.txt"}');
  });
});

describe('toOpenAITools', () => {
  it('转成 function tool 形状', () => {
    expect(
      toOpenAITools([
        {
          name: 'read_file',
          description: '读取文件',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ]),
    ).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: '读取文件',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ]);
  });
});

describe('toModelResponse', () => {
  it('解析文本、tool_calls 与 usage', () => {
    const response = toModelResponse(
      completion({
        content: '我先读文件。',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
      }),
    );

    expect(response.message.content).toEqual([text('我先读文件。')]);
    expect(response.message.toolCalls).toEqual([
      {
        id: 'call_1',
        name: 'read_file',
        arguments: { path: 'a.txt' },
        raw: '{"path":"a.txt"}',
      },
    ]);
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(response.stopReason).toBe('tool_use');
  });

  it('finish_reason=length 映射为 max_tokens', () => {
    expect(toModelResponse(completion({ content: '半截', finishReason: 'length' })).stopReason).toBe(
      'max_tokens',
    );
  });

  it('坏 JSON 参数不让整轮崩掉', () => {
    const response = toModelResponse(
      completion({
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{oops' }],
      }),
    );

    expect(response.message.toolCalls[0]?.arguments).toEqual({ __invalid_json: '{oops' });
  });
});

describe('toModelStream', () => {
  it('文本片段即时抛出，tool_call 分片在流结束时拼完整', async () => {
    const stream = toModelStream(
      asyncItems([
        chunk({ role: 'assistant', content: '你' }),
        chunk({ content: '好' }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":' },
            },
          ],
        }),
        chunk({
          tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }],
        }),
        chunk({}, 'tool_calls'),
        {
          ...chunk({}),
          choices: [],
          usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
        },
      ]),
    );

    const deltas: string[] = [];
    let next = await stream.next();
    while (!next.done) {
      deltas.push(next.value.text);
      next = await stream.next();
    }

    expect(deltas).toEqual(['你', '好']);
    expect(next.value.message.content).toEqual([text('你好')]);
    expect(next.value.message.toolCalls).toEqual([
      {
        id: 'call_1',
        name: 'read_file',
        arguments: { path: 'a.txt' },
        raw: '{"path":"a.txt"}',
      },
    ]);
    expect(next.value.usage).toEqual({ inputTokens: 9, outputTokens: 3 });
    expect(next.value.stopReason).toBe('tool_use');
  });

  it('纯文本流以 end_turn 结束', async () => {
    const stream = toModelStream(
      asyncItems([chunk({ content: '搞定' }), chunk({}, 'stop')]),
    );

    let next = await stream.next();
    while (!next.done) {
      next = await stream.next();
    }

    expect(next.value.message.toolCalls).toEqual([]);
    expect(next.value.stopReason).toBe('end_turn');
  });
});

describe('createConfiguredModel', () => {
  it('没配 provider 时返回 undefined', () => {
    expect(createConfiguredModel(ConfigSchema.parse({}))).toBeUndefined();
  });

  it('缺密钥时报可操作的错误', () => {
    const config = ConfigSchema.parse({
      model: 'deepseek-chat',
      provider: { apiKeyEnv: 'OMNI_TEST_MISSING_KEY' },
    });

    expect(() => createConfiguredModel(config)).toThrow(/OMNI_TEST_MISSING_KEY/);
  });

  it('配了 provider 但 model 仍是 fake 时报错', () => {
    const config = ConfigSchema.parse({
      provider: { apiKey: 'test-key' },
    });

    expect(() => createConfiguredModel(config)).toThrow(/model 仍是 fake/);
  });

  it('从环境变量取密钥并构造 OpenAI 兼容客户端', () => {
    vi.stubEnv('OMNI_TEST_KEY', 'test-key');
    const config = ConfigSchema.parse({
      model: 'deepseek-chat',
      provider: {
        baseURL: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'OMNI_TEST_KEY',
      },
    });

    expect(createConfiguredModel(config)?.name).toBe('openai');
    vi.unstubAllEnvs();
  });
});
