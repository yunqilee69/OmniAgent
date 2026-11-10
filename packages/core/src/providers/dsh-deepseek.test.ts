import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../domain/message';
import type { ModelRequest } from './types';
import { DEFAULT_DSH_MODEL, DeepSeekMessagesError, DeepSeekMessagesModel, serializeDshRequest } from './dsh-deepseek';
import { replayEndpointHash } from './replay-identity';

const request: ModelRequest = {
  model: 'deepseek-flash', system: 'Be helpful',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
};
const event = (type: string, fields: Record<string, unknown> = {}) => ({ type, ...fields });
const start = () => event('message_start', { message: { usage: { input_tokens: 10, cache_read_input_tokens: 3 } } });
const blockStart = (index: number, content_block: unknown) => event('content_block_start', { index, content_block });
const blockDelta = (index: number, delta: unknown) => event('content_block_delta', { index, delta });
const blockStop = (index: number) => event('content_block_stop', { index });
const finish = (reason = 'end_turn') => [event('message_delta', { delta: { stop_reason: reason }, usage: { output_tokens: 7 } }), event('message_stop')];
const textEvents = () => [start(), blockStart(0, { type: 'text', text: '' }), blockDelta(0, { type: 'text_delta', text: 'Hello' }), blockStop(0), ...finish()];
const toolEvents = (raw = '{"path":"a.txt"}', reason = 'tool_use') => [
  start(), blockStart(0, { type: 'thinking', thinking: '' }),
  blockDelta(0, { type: 'thinking_delta', thinking: 'Think' }),
  blockDelta(0, { type: 'signature_delta', signature: 'signed' }), blockStop(0),
  blockStart(1, { type: 'text', text: 'Reading ' }), blockDelta(1, { type: 'text_delta', text: 'now.' }), blockStop(1),
  blockStart(2, { type: 'tool_use', id: 'call-1', name: 'read', input: {} }),
  blockDelta(2, { type: 'input_json_delta', partial_json: raw }), blockStop(2),
  blockStart(3, { type: 'text', text: 'Done' }), blockStop(3), ...finish(reason),
];
function sse(events: Record<string, unknown>[], newline = '\n') {
  return events.map((item) => `event: ${item.type}${newline}data: ${JSON.stringify(item)}${newline}${newline}`).join('');
}
function response(events: Record<string, unknown>[]) {
  return new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } });
}
function model(events: Record<string, unknown>[]) {
  return new DeepSeekMessagesModel({ apiKey: 'secret', fetch: async () => response(events) });
}
async function collect<T, R>(iterator: AsyncGenerator<T, R>) {
  const deltas: T[] = [];
  let next = await iterator.next();
  while (!next.done) { deltas.push(next.value); next = await iterator.next(); }
  return { deltas, result: next.value };
}

describe('DeepSeek Messages model', () => {
  it('sends DSH defaults and translates SSE text and cumulative usage', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(textEvents()));
    const result = await collect(new DeepSeekMessagesModel({ apiKey: 'secret', fetch: fetcher }).stream(request));
    expect(DEFAULT_DSH_MODEL).toBe('deepseek-flash');
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/anthropic/v1/messages');
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-api-key')).toBe('secret');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'deepseek-flash', stream: true, max_tokens: 256000, system: 'Be helpful',
      thinking: { type: 'enabled' }, output_config: { effort: 'high' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object' } }],
    });
    expect(result.deltas).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(result.result).toMatchObject({
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], toolCalls: [] },
      usage: { inputTokens: 10, outputTokens: 7, cachedInputTokens: 3 },
      dshUsage: { inputTokens: 10, outputTokens: 7, cacheReadTokens: 3 }, stopReason: 'end_turn',
    });
  });

  it('counts cached input for context without serializing metering metadata', async () => {
    const result = await collect(model(textEvents()).stream(request));
    expect(result.result.contextInputTokens).toBe(13);
    const message = { ...result.result.message, usage: { inputTokens: 13, outputTokens: 7 },
      contextSample: { provider: 'deepseek-official', model: 'deepseek-flash', historyHash: 'hash',
        systemTokens: 1, toolsTokens: 2, messageTokens: 3 } };
    const serialized = JSON.stringify(serializeDshRequest({ ...request, messages: [...request.messages, message] }));
    expect(serialized).not.toContain('contextSample');
    expect(serialized).not.toContain('inputTokens');
    expect(serialized).not.toContain('historyHash');
  });

  it('does not report prompt occupancy when input usage is missing', async () => {
    const events = textEvents();
    events[0] = event('message_start', { message: { usage: { cache_read_input_tokens: 3 } } });
    const result = await collect(model(events).stream(request));
    expect(result.result.contextInputTokens).toBeUndefined();
  });

  it('forwards reasoning chunks through the plain stream', async () => {
    const result = await collect(model(toolEvents()).stream(request));
    expect(result.deltas).toEqual([
      { type: 'reasoning', text: 'Think' },
      { type: 'text', text: 'Reading ' },
      { type: 'text', text: 'now.' },
      { type: 'text', text: 'Done' },
    ]);
  });

  it('exposes ordered reasoning, text and tool fragments and a replayable assistant', async () => {
    const result = await collect(model(toolEvents()).streamDetailed(request));
    expect(result.deltas).toEqual([
      { type: 'reasoning', index: 0, text: 'Think' }, { type: 'text', index: 1, text: 'Reading ' },
      { type: 'text', index: 1, text: 'now.' }, { type: 'tool', index: 2, id: 'call-1', name: 'read', argumentsDelta: '' },
      { type: 'tool', index: 2, id: 'call-1', argumentsDelta: '{"path":"a.txt"}' },
      { type: 'text', index: 3, text: 'Done' },
    ]);
    expect(result.result.message).toEqual({
      role: 'assistant', content: [{ type: 'text', text: 'Reading now.' }, { type: 'text', text: 'Done' }],
      toolCalls: [{ id: 'call-1', name: 'read', arguments: { path: 'a.txt' }, raw: '{"path":"a.txt"}' }],
      dshReplay: { kind: 'deepseek-messages', version: 1, provider: 'deepseek-official', model: 'deepseek-flash',
        endpoint: replayEndpointHash('https://api.deepseek.com/anthropic/v1/messages'), blocks: [
        { type: 'thinking', thinking: 'Think', signature: 'signed' }, { type: 'text', text: 'Reading now.' },
        { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a.txt' }, raw: '{"path":"a.txt"}' },
        { type: 'text', text: 'Done' },
      ] },
    });
    expect(result.result.stopReason).toBe('tool_use');
    expect(JSON.stringify(result.result)).not.toContain('secret');
  });

  it('replays signed thinking and ordered blocks through a tool cycle', async () => {
    const first = await model(toolEvents()).complete(request);
    const history: Message[] = [...request.messages, first.message,
      { role: 'tool', results: [{ callId: 'call-1', name: 'read', ok: false, content: 'denied', truncated: false }] },
      { role: 'user', content: [{ type: 'text', text: 'retry later' }] }];
    expect(serializeDshRequest({ ...request, messages: history }).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'Think', signature: 'signed' },
        { type: 'text', text: 'Reading now.' }, { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a.txt' } },
        { type: 'text', text: 'Done' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'denied' }], is_error: true },
        { type: 'text', text: 'retry later' }] },
    ]);
  });

  it('does not replay signed thinking to a different Messages endpoint', async () => {
    const first = await new DeepSeekMessagesModel({ apiKey: 'secret', baseURL: 'https://one.example/anthropic',
      fetch: async () => response(toolEvents()) }).complete(request);
    const history: Message[] = [first.message,
      { role: 'tool', results: [{ callId: 'call-1', name: 'read', ok: true, content: 'ok', truncated: false }] }];
    let outgoing = '';
    const next = new DeepSeekMessagesModel({ apiKey: 'secret', baseURL: 'https://two.example/anthropic',
      fetch: async (_input, init) => { outgoing = String(init?.body); return response(textEvents()); } });
    await next.complete({ ...request, messages: history });
    expect(outgoing).not.toContain('signed');
  });

  it('never replays signatures from foreign, different-model, or changed assistant metadata', async () => {
    const first = await model(toolEvents()).complete(request);
    const results: Message = { role: 'tool', results: [{ callId: 'call-1', name: 'read', ok: true, content: 'ok', truncated: false }] };
    expect(JSON.stringify(serializeDshRequest({ ...request, model: 'other', messages: [first.message, results] }))).not.toContain('signed');
    const foreign = { ...first.message, dshReplay: { ...first.message.dshReplay, provider: 'foreign' } };
    const changed = { ...first.message, content: [{ type: 'text' as const, text: 'altered' }] };
    for (const assistant of [foreign, changed]) {
      const body = serializeDshRequest({ ...request, messages: [assistant as unknown as Message, results] });
      expect(JSON.stringify(body)).not.toContain('signed');
      expect(body.messages[0]?.content.some((block) => block.type === 'thinking')).toBe(false);
    }
  });

  it('serializes images, system snapshots, settings and parallel tool results', () => {
    const body = serializeDshRequest({ ...request, messages: [
      { role: 'system', content: 'old' }, { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AQID' }] },
      { role: 'assistant', content: [], toolCalls: [{ id: 'a', name: 'read', arguments: {} }, { id: 'b', name: 'read', arguments: {} }] },
      { role: 'tool', results: [{ callId: 'a', name: 'read', ok: true, content: '', truncated: false },
        { callId: 'b', name: 'read', ok: false, content: 'bad', truncated: false }] },
      { role: 'system', content: 'new' },
    ] }, { maxTokens: 42, reasoningEffort: 'off' });
    expect(body).toMatchObject({ system: 'Be helpful\n\nold', max_tokens: 42, thinking: { type: 'disabled' } });
    expect(body.messages[3]).toEqual({ role: 'system', content: [{ type: 'text', text: 'new' }] });
    expect(body.output_config).toBeUndefined();
    expect(body.messages[0]?.content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } }]);
    expect(body.messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: [], is_error: false },
      { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'bad' }], is_error: true },
    ]);
  });

  it.each([
    [{ role: 'tool', results: [{ callId: 'a', name: 'read', ok: true, content: 'ok', truncated: false }] }],
    [{ role: 'assistant', content: [], toolCalls: [{ id: 'a', name: 'read', arguments: {} }] }],
    [{ role: 'assistant', content: [], toolCalls: [{ id: 'a', name: 'read', arguments: {} }, { id: 'a', name: 'read', arguments: {} }] }],
  ])('rejects unmatched or duplicate tool history %#', (...messages) => {
    expect(() => serializeDshRequest({ ...request, messages: messages as Message[] })).toThrow(/tool/i);
  });

  it.each(['{', '[]', 'null', '"hello"', '42'])('rejects malformed or non-object tool input %s', async (raw) => {
    await expect(model(toolEvents(raw)).complete(request)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });
  it('does not return tool calls when output is cut off by max_tokens', async () => {
    for (const raw of ['{"path":"a"}', '{"path":']) {
      await expect(model(toolEvents(raw, 'max_tokens')).complete(request)).rejects.toMatchObject({ code: 'TRUNCATED_TOOL_CALL' });
    }
  });
  it.each([
    [start(), blockStart(0, { type: 'tool_use', id: '', name: 'read', input: {} }), blockStop(0), ...finish('tool_use')],
    [start(), blockStart(0, { type: 'text', text: '' }), ...finish()],
    [start(), blockStart(0, { type: 'text', text: '' }), blockStop(0)],
    [start(), blockDelta(0, { type: 'text_delta', text: 'x' }), ...finish()],
    [start(), blockStart(0, { type: 'text', text: 'x' }), blockStop(0), ...finish('tool_use')],
  ])('rejects incomplete or inconsistent protocol events %#', async (...events) => {
    await expect(model(events).complete(request)).rejects.toBeInstanceOf(DeepSeekMessagesError);
  });

  it('handles split UTF-8 bytes, CRLF, comments, multiline data and fragmented network chunks', async () => {
    const lines = [': ping\r\n\r\n', ...textEvents().map((e, i) => i === 2
      ? 'event: content_block_delta\r\ndata: {"type":"content_block_delta",\r\ndata: "index":0,"delta":{"type":"text_delta","text":"世界"}}\r\n\r\n'
      : sse([e], '\r\n'))].join('');
    const bytes = new TextEncoder().encode(lines);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close();
    } });
    const client = new DeepSeekMessagesModel({ apiKey: 'secret', fetch: async () => new Response(body) });
    expect((await client.complete(request)).message.content).toEqual([{ type: 'text', text: '世界' }]);
  });
  it('accepts CR-only frame separators at the end of a stream', async () => {
    const client = new DeepSeekMessagesModel({ apiKey: 'secret', fetch: async () => new Response(sse(textEvents(), '\r')) });
    expect((await client.complete(request)).message.content).toEqual([{ type: 'text', text: 'Hello' }]);
  });
  it('rejects event-name mismatches and unterminated SSE frames', async () => {
    for (const body of [sse(textEvents()).replace('event: message_start', 'event: other'), sse(textEvents()).slice(0, -1)]) {
      const client = new DeepSeekMessagesModel({ apiKey: 'secret', fetch: async () => new Response(body) });
      await expect(client.complete(request)).rejects.toMatchObject({ code: expect.any(String) });
    }
  });
  it('classifies HTTP and stream errors', async () => {
    const http = new DeepSeekMessagesModel({ apiKey: 'secret', fetch: async () => new Response(
      JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }),
      { status: 429, headers: { 'retry-after': '3', 'request-id': 'req-1' } }) });
    await expect(http.complete(request)).rejects.toMatchObject({ code: 'RATE_LIMIT', status: 429, retryAfterMs: 3000, requestId: 'req-1' });
    await expect(model([event('error', { error: { type: 'overloaded_error', message: 'busy' } })]).complete(request))
      .rejects.toMatchObject({ code: 'SERVER', message: 'DeepSeek Messages provider server error' });
  });

  it('does not expose provider-controlled error text that may echo request credentials', async () => {
    const leaked = new DeepSeekMessagesModel({ apiKey: 'SUPER_SECRET_KEY', fetch: async () => new Response(
      JSON.stringify({ error: { type: 'authentication_error', message: 'Rejected SUPER_SECRET_KEY' } }), { status: 401 },
    ) });
    await expect(leaked.complete(request)).rejects.toMatchObject({ code: 'AUTH' });
    await expect(leaked.complete(request)).rejects.not.toThrow(/SUPER_SECRET_KEY/);
  });
  it('classifies caller cancellation before and during a request', async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>(async () => response(textEvents()));
    const client = new DeepSeekMessagesModel({ apiKey: 'secret', fetch: fetcher });
    await expect(client.complete({ ...request, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fetcher).not.toHaveBeenCalled();
    const waiting = new DeepSeekMessagesModel({ apiKey: 'secret', fetch: async () => new Promise<Response>(() => {}) });
    const active = new AbortController();
    const result = waiting.complete({ ...request, signal: active.signal }); active.abort();
    await expect(result).rejects.toMatchObject({ code: 'ABORTED' });
  });
  it('cancels the underlying stream when a consumer stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(sse(textEvents().slice(0, 3)))); },
      cancel() { cancelled = true; },
    });
    const stream = new DeepSeekMessagesModel({ apiKey: 'secret', fetch: async () => new Response(body) }).stream(request);
    expect(await stream.next()).toEqual({ done: false, value: { type: 'text', text: 'Hello' } });
    await stream.return(undefined as never);
    expect(cancelled).toBe(true);
  });
  it('times out an idle stream even if the transport ignores abort', async () => {
    vi.useFakeTimers();
    try {
      const client = new DeepSeekMessagesModel({ apiKey: 'secret', streamIdleTimeoutMs: 25,
        fetch: async () => new Promise<Response>(() => {}) });
      const pending = expect(client.complete(request)).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(25); await pending;
    } finally { vi.useRealTimers(); }
  });
});
