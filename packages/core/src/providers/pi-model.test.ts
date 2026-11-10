import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, AssistantMessageEvent, Context, Model, Api, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { ModelRequest, ModelResponse, ModelStreamDelta } from './types';
import { PiAiModel, listPiAiCatalogProviders, resolvePiAiRoute } from './pi-model';
import type { PiAiRouteConfig } from './pi-model';
import { replayEndpointHash } from './replay-identity';

const usage = {
  input: 12, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 19,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const baseRequest: ModelRequest = {
  model: 'fixture-model', system: 'system', messages: [], tools: [],
};
const route = {
  api: 'openai-completions' as const,
  baseURL: 'https://example.invalid/v1',
  apiKey: 'fixture-key',
  models: [{ id: 'fixture-model', contextWindow: 8192, maxTokens: 1024 }],
};

function native(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture-model',
    content: [], stopReason: 'stop', usage, timestamp: 0, ...overrides,
  };
}

function eventStream(events: AssistantMessageEvent[]) {
  return (async function* () { yield* events; })();
}

function fixture(events: AssistantMessageEvent[], overrides: Partial<PiAiRouteConfig> = {}) {
  const dispatch = vi.fn((_model: Model<Api>, _context: Context, _options: SimpleStreamOptions) => eventStream(events));
  const client = new PiAiModel({ provider: 'fixture', routes: { fixture: { ...route, ...overrides } } }, { stream: dispatch });
  return { client, dispatch };
}

async function collect(stream: AsyncGenerator<ModelStreamDelta, ModelResponse>) {
  const deltas: string[] = [];
  let next = await stream.next();
  while (!next.done) {
    if (next.value.type === 'text') deltas.push(next.value.text);
    next = await stream.next();
  }
  return { deltas, response: next.value };
}

describe('pi-ai routes', () => {
  it('resolves a built-in catalog and an explicitly configured custom model', () => {
    expect(listPiAiCatalogProviders()).toContain('anthropic');
    const anthropic = resolvePiAiRoute('anthropic', { apiKey: 'test' });
    expect(anthropic.models.length).toBeGreaterThan(0);
    expect(anthropic.models[0]).toMatchObject({ provider: 'anthropic', api: 'anthropic-messages' });
    expect(resolvePiAiRoute('fixture', route).models[0]).toMatchObject({
      id: 'fixture-model', provider: 'fixture', api: 'openai-completions',
      baseUrl: 'https://example.invalid/v1', contextWindow: 8192, maxTokens: 1024,
    });
    expect(() => resolvePiAiRoute('missing', { apiKey: 'test' })).toThrow(/model|catalog/i);
  });

  it('refuses unknown models and does not borrow another route credential', async () => {
    const dispatch = vi.fn();
    const client = new PiAiModel({ provider: 'one', routes: {
      one: { ...route, apiKey: undefined, apiKeyEnv: 'OMNI_PI_TEST_MISSING_KEY' },
      two: { ...route, apiKey: 'other-secret' },
    } }, { stream: dispatch });
    await expect(client.complete(baseRequest)).rejects.toThrow(/OMNI_PI_TEST_MISSING_KEY/);
    await expect(client.complete({ ...baseRequest, model: 'unconfigured' })).rejects.toThrow(/unconfigured/);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('PiAiModel', () => {
  it('reports positive cache reads separately from total prompt occupancy', async () => {
    const message = native({ usage: { ...usage, input: 10, cacheRead: 3, cacheWrite: 2 } });
    const { client } = fixture([{ type: 'done', reason: 'stop', message }]);
    const response = await client.complete(baseRequest);
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 7, cachedInputTokens: 3 });
    expect(response.contextInputTokens).toBe(15);
    const missing = fixture([{ type: 'done', reason: 'stop', message: native() }]);
    expect((await missing.client.complete(baseRequest)).usage).not.toHaveProperty('cachedInputTokens');
  });
  it('streams text and returns completed, ordered tool calls and usage', async () => {
    const call = { type: 'toolCall' as const, id: 'call_1', name: 'read', arguments: { path: 'a.txt' } };
    const message = native({ content: [{ type: 'text', text: 'Hello' }, call], stopReason: 'toolUse' });
    const { client, dispatch } = fixture([
      { type: 'start', partial: native() },
      { type: 'text_delta', contentIndex: 0, delta: 'Hel', partial: native() },
      { type: 'text_delta', contentIndex: 0, delta: 'lo', partial: native() },
      { type: 'toolcall_start', contentIndex: 1, partial: native({ content: [call] }) },
      { type: 'toolcall_delta', contentIndex: 1, delta: '{"path":', partial: native() },
      { type: 'toolcall_delta', contentIndex: 1, delta: '"a.txt"}', partial: native() },
      { type: 'toolcall_end', contentIndex: 1, toolCall: call, partial: message },
      { type: 'done', reason: 'toolUse', message },
    ]);
    const result = await collect(client.stream(baseRequest));
    expect(result.deltas).toEqual(['Hel', 'lo']);
    expect(result.response).toMatchObject({
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], toolCalls: [
        { id: 'call_1', name: 'read', arguments: { path: 'a.txt' }, raw: '{"path":"a.txt"}' },
      ] }, usage: { inputTokens: 12, outputTokens: 7 }, stopReason: 'tool_use',
    });
    expect(dispatch.mock.calls[0]?.[2]).toMatchObject({ apiKey: 'fixture-key' });
  });

  it('forwards provider thinking as reasoning deltas', async () => {
    const message = native({
      content: [{ type: 'thinking', thinking: 'plan', thinkingSignature: 'sig' }, { type: 'text', text: 'Done' }],
    });
    const { client } = fixture([
      { type: 'start', partial: native() },
      { type: 'thinking_delta', contentIndex: 0, delta: 'pl', partial: native() },
      { type: 'thinking_delta', contentIndex: 0, delta: 'an', partial: native() },
      { type: 'text_delta', contentIndex: 1, delta: 'Done', partial: native() },
      { type: 'done', reason: 'stop', message },
    ]);
    const deltas: Array<{ type: string; text?: string }> = [];
    const stream = client.stream(baseRequest);
    let next = await stream.next();
    while (!next.done) {
      deltas.push(next.value);
      next = await stream.next();
    }
    expect(deltas).toEqual([
      { type: 'reasoning', text: 'pl' },
      { type: 'reasoning', text: 'an' },
      { type: 'text', text: 'Done' },
    ]);
  });

  it('never returns tool calls after truncation, even if a valid call ended', async () => {
    const call = { type: 'toolCall' as const, id: 'call_1', name: 'read', arguments: { path: 'a' } };
    const message = native({ content: [{ type: 'text', text: 'partial' }, call], stopReason: 'length' });
    const { client } = fixture([
      { type: 'start', partial: native() },
      { type: 'toolcall_end', contentIndex: 1, toolCall: call, partial: message },
      { type: 'done', reason: 'length', message },
    ]);
    const response = await client.complete(baseRequest);
    expect(response.stopReason).toBe('max_tokens');
    expect(response.message.toolCalls).toEqual([]);
  });

  it('fails the entire response when any completed tool argument is malformed', async () => {
    const valid = { type: 'toolCall' as const, id: 'good', name: 'read', arguments: { path: 'a' } };
    const invalid = { type: 'toolCall' as const, id: 'bad', name: 'read', arguments: {}, argumentsError: 'bad JSON' };
    const message = native({ content: [valid, invalid], stopReason: 'toolUse' });
    const { client } = fixture([
      { type: 'toolcall_end', contentIndex: 0, toolCall: valid, partial: message },
      { type: 'toolcall_end', contentIndex: 1, toolCall: invalid, partial: message },
      { type: 'done', reason: 'toolUse', message },
    ]);
    await expect(client.complete(baseRequest)).rejects.toThrow(/tool|argument/i);
  });

  it('fails closed when the event stream ends without a terminal event', async () => {
    const { client } = fixture([{ type: 'start', partial: native() }]);
    await expect(client.complete(baseRequest)).rejects.toThrow(/terminal|ended/i);
  });

  it('projects user images, tool declarations and tool results without dropping system history', async () => {
    const message = native({ content: [{ type: 'text', text: 'ok' }] });
    const { client, dispatch } = fixture([{ type: 'done', reason: 'stop', message }], {
      models: [{ id: 'fixture-model', contextWindow: 8192, maxTokens: 1024, input: ['text', 'image'] }],
    });
    await client.complete({ ...baseRequest, messages: [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', data: 'YWJj', fileName: 'image.png', filePath: '.images/image.png' }] },
      { role: 'system', content: 'later instruction' },
      { role: 'assistant', content: [], toolCalls: [{ id: 'a', name: 'read', arguments: { path: 'a' } }] },
      { role: 'tool', results: [{ callId: 'a', name: 'read', ok: false, content: 'denied', truncated: false }] },
    ], tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } }] });
    const context = dispatch.mock.calls[0]?.[1];
    expect(context).toMatchObject({ systemPrompt: 'system', tools: [{ name: 'read' }], messages: [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', data: 'YWJj' }] },
      { role: 'system', content: 'later instruction' },
      { role: 'assistant', api: 'omni-foreign', content: [{ type: 'toolCall', id: 'a', name: 'read', arguments: { path: 'a' } }] },
      { role: 'toolResult', toolCallId: 'a', toolName: 'read', isError: true, content: [{ type: 'text', text: 'denied' }] },
    ] });
  });

  it('restores validated native replay and marks mismatched replay as foreign', async () => {
    const original = native({ content: [
      { type: 'thinking', thinking: 'private', thinkingSignature: 'sig' },
      { type: 'text', text: 'answer', textSignature: 'text-sig' },
    ] });
    const { client, dispatch } = fixture([{ type: 'done', reason: 'stop', message: original }]);
    const first = await client.complete(baseRequest);
    expect(first.message).toHaveProperty('providerReplay.kind', 'pi-ai');
    await client.complete({ ...baseRequest, messages: [first.message] });
    expect(dispatch.mock.calls[1]?.[1].messages[0]).toMatchObject({ api: original.api, provider: 'fixture', content: original.content });
    const tampered = { ...first.message, content: [{ type: 'text' as const, text: 'changed' }] };
    await client.complete({ ...baseRequest, messages: [tampered] });
    expect(dispatch.mock.calls[2]?.[1].messages[0]).toMatchObject({ api: 'omni-foreign', content: [{ type: 'text', text: 'changed' }] });
  });

  it('degrades native replay when the configured endpoint changes', async () => {
    const firstMessage = native({ content: [{ type: 'thinking', thinking: 'private', thinkingSignature: 'signed' }] });
    const first = new PiAiModel({ provider: 'fixture', routes: { fixture: route } }, {
      stream: () => eventStream([{ type: 'done', reason: 'stop', message: firstMessage }]),
    });
    const response = await first.complete(baseRequest);
    expect(response.message.providerReplay).toMatchObject({ endpoint: replayEndpointHash(route.baseURL) });

    const dispatch = vi.fn((_model: Model<Api>, _context: Context, _options: SimpleStreamOptions) =>
      eventStream([{ type: 'done', reason: 'stop', message: native() }]));
    const next = new PiAiModel({ provider: 'fixture', routes: { fixture: { ...route, baseURL: 'https://two.example/v1' } } }, { stream: dispatch });
    await next.complete({ ...baseRequest, messages: [response.message] });
    expect(dispatch.mock.calls[0]?.[1].messages[0]).toMatchObject({ provider: 'omni-foreign', content: [] });
    expect(JSON.stringify(dispatch.mock.calls[0]?.[1].messages)).not.toContain('signed');
    expect(JSON.stringify(dispatch.mock.calls[0]?.[1].messages)).not.toContain('private');
  });

  it('drops native replay but keeps ordinary tool calls when provider or model identity changes', async () => {
    const call = { type: 'toolCall' as const, id: 'call_1', name: 'read', arguments: { path: 'a' } };
    const original = native({ content: [
      { type: 'thinking', thinking: 'private', thinkingSignature: 'signed' },
      { type: 'text', text: 'answer' },
      call,
    ], stopReason: 'toolUse' });
    const { client, dispatch } = fixture([
      { type: 'toolcall_end', contentIndex: 2, toolCall: call, partial: original },
      { type: 'done', reason: 'toolUse', message: original },
    ]);
    const response = await client.complete(baseRequest);
    for (const replay of [
      { ...response.message.providerReplay!, provider: 'another' },
      { ...response.message.providerReplay!, model: 'another' },
    ]) {
      await client.complete({ ...baseRequest, messages: [{ ...response.message, providerReplay: replay }] });
    }
    for (const call of dispatch.mock.calls.slice(1)) {
      expect(call[1].messages[0]).toMatchObject({ provider: 'omni-foreign', content: [
        { type: 'text', text: 'answer' },
        { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a' } },
      ] });
      expect(JSON.stringify(call[1].messages)).not.toContain('signed');
      expect(JSON.stringify(call[1].messages)).not.toContain('private');
    }
  });

  it('dispatches through pi-ai with a mocked OpenAI-compatible HTTP stream', async () => {
    const frames = [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi ' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 3 } },
    ];
    const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
    const fetch = vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    try {
      const client = new PiAiModel({ provider: 'fixture', routes: { fixture: route } });
      const result = await collect(client.stream(baseRequest));
      expect(result.deltas).toEqual(['Hi ']);
      expect(result.response).toMatchObject({ stopReason: 'tool_use', usage: { inputTokens: 4, outputTokens: 3 },
        message: { toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }] } });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toMatch(/^https:\/\/example\.invalid\/v1/);
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-key');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses ambient authentication for a redirected built-in endpoint', () => {
    expect(() => resolvePiAiRoute('anthropic', { auth: 'ambient', baseURL: 'https://example.invalid' })).toThrow(/ambient/i);
  });

  it('propagates cancellation and aborts the provider when a stream consumer stops', async () => {
    const { client, dispatch } = fixture([
      { type: 'text_delta', contentIndex: 0, delta: 'a', partial: native() },
      { type: 'done', reason: 'stop', message: native({ content: [{ type: 'text', text: 'a' }] }) },
    ]);
    const controller = new AbortController();
    const stream = client.stream({ ...baseRequest, signal: controller.signal });
    await stream.next();
    const signal = dispatch.mock.calls[0]?.[2].signal;
    expect(signal?.aborted).toBe(false);
    await stream.return(undefined as never);
    expect(signal?.aborted).toBe(true);
  });
});
