/*
 * Adapted from DeepSeek Harness llm-deepseek/src/{translate,sse,transport}.ts.
 * Copyright (c) 2026 DeepSeek. MIT License.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { ContentPart, ToolCall } from '../domain/message';
import { DeepSeekMessagesError } from './dsh-messages-types';
import { replayEndpointHash } from './replay-identity';
import type { DshModelResponse, DshReplayBlock, DshStreamDelta, DshUsage } from './dsh-messages-types';

function malformed(detail: string): never { throw new DeepSeekMessagesError(`DeepSeek Messages stream: ${detail}`, 'MALFORMED_RESPONSE'); }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return malformed('expected object');
  return value as Record<string, unknown>;
}
function string(value: unknown): string { return typeof value === 'string' ? value : malformed('expected string'); }

export function providerError(raw: unknown, status?: number, headers?: Headers): DeepSeekMessagesError {
  const envelope = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const value = envelope.error;
  const error = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const remoteMessage = typeof error.message === 'string' ? error.message : '';
  const type = typeof error.type === 'string' ? error.type : '';
  const detail = `${type} ${typeof error.code === 'string' ? error.code : ''} ${remoteMessage}`;
  let code: string;
  if (status === 401 || status === 403 || ['authentication_error', 'permission_error'].includes(type)) code = 'AUTH';
  else if (status === 402 || /(?:quota|insufficient.balance|insufficient.credit)/i.test(detail)) code = 'QUOTA';
  else if (status === 429 || type === 'rate_limit_error') code = 'RATE_LIMIT';
  else if (/context.{0,30}(?:limit|length|window|exceed)|maximum context/i.test(detail)) code = 'CONTEXT_WINDOW_EXCEEDED';
  else if (status === 400 || status === 413 || type === 'invalid_request_error') code = 'INVALID_REQUEST';
  else if ((status !== undefined && status >= 500) || ['api_error', 'overloaded_error'].includes(type)) code = 'SERVER';
  else code = status === undefined ? 'SERVER' : `HTTP_${status}`;
  const message = code === 'AUTH' ? 'DeepSeek Messages authentication failed'
    : code === 'QUOTA' ? 'DeepSeek Messages quota exceeded'
      : code === 'RATE_LIMIT' ? 'DeepSeek Messages rate limited'
        : code === 'CONTEXT_WINDOW_EXCEEDED' ? 'DeepSeek Messages context window exceeded'
          : code === 'INVALID_REQUEST' ? 'DeepSeek Messages request was rejected'
            : code === 'SERVER' ? 'DeepSeek Messages provider server error'
              : status === undefined ? 'DeepSeek Messages provider request failed' : `DeepSeek Messages HTTP ${status} error`;
  const retry = headers?.get('retry-after');
  const delay = retry == null ? NaN : /^\d+(?:\.\d+)?$/u.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
  const requestId = headers?.get('request-id') ?? headers?.get('x-request-id') ?? headers?.get('x-deepseek-request-id');
  return new DeepSeekMessagesError(message, code, { ...(status === undefined ? {} : { status }),
    ...(Number.isFinite(delay) && delay > 0 ? { retryAfterMs: delay } : {}), ...(requestId ? { requestId } : {}) });
}

/** Await one unit of transport activity, even if the transport ignores AbortSignal. */
export function waitForActivity<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number, controller: AbortController): Promise<T> {
  if (signal.aborted) return Promise.reject(new DeepSeekMessagesError('DeepSeek Messages request aborted', 'ABORTED'));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); };
    const aborted = () => { cleanup(); reject(new DeepSeekMessagesError('DeepSeek Messages request aborted', 'ABORTED')); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new DeepSeekMessagesError('DeepSeek Messages stream idle timeout', 'TIMEOUT'));
      controller.abort();
    }, timeoutMs);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

/** Decode only blank-line-terminated SSE frames, retaining UTF-8 across reads. */
export async function* parseDshSse(
  body: ReadableStream<Uint8Array>, signal: AbortSignal, timeoutMs: number, controller: AbortController,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let eventName: string | undefined;
  try {
    while (true) {
      const read = await waitForActivity(reader.read(), signal, timeoutMs, controller);
      buffer += read.done ? decoder.decode() : decoder.decode(read.value, { stream: true });
      while (true) {
        const newline = buffer.search(/[\r\n]/u);
        if (newline < 0) break;
        if (!read.done && buffer[newline] === '\r' && newline === buffer.length - 1) break;
        const line = buffer.slice(0, newline);
        const width = buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(newline + width);
        if (line === '') {
          if (data.length) {
            let parsed: unknown;
            try { parsed = JSON.parse(data.join('\n')); } catch { return malformed('SSE contains invalid JSON'); }
            const decoded = object(parsed);
            if (typeof decoded.type !== 'string' || (eventName !== undefined && eventName !== decoded.type)) return malformed('SSE event type mismatch');
            if (decoded.type === 'error') throw providerError(decoded);
            data = []; eventName = undefined;
            yield decoded;
          } else eventName = undefined;
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') eventName = value;
        if (field === 'data') data.push(value);
      }
      if (read.done) break;
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type Block = { index: number; content: DshReplayBlock; closed: boolean; json: string; hasJson: boolean };
function updateUsage(usage: DshUsage, raw: unknown) {
  const fields = object(raw);
  const keys = { input_tokens: 'inputTokens', output_tokens: 'outputTokens', cache_read_input_tokens: 'cacheReadTokens', cache_creation_input_tokens: 'cacheWriteTokens' } as const;
  for (const [wire, local] of Object.entries(keys)) {
    const value = fields[wire];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 0) return malformed(`invalid ${wire}`);
    usage[local] = value as number;
  }
}
function blockIndex(event: Record<string, unknown>): number {
  return Number.isSafeInteger(event.index) && (event.index as number) >= 0 ? event.index as number : malformed('invalid block index');
}
function startBlock(event: Record<string, unknown>, index: number): Block {
  const native = object(event.content_block);
  let content: DshReplayBlock;
  if (native.type === 'text') content = { type: 'text', text: string(native.text) };
  else if (native.type === 'thinking') content = { type: 'thinking', thinking: string(native.thinking),
    ...(native.signature === undefined ? {} : { signature: string(native.signature) }) };
  else if (native.type === 'tool_use') {
    const id = string(native.id), name = string(native.name), input = object(native.input);
    if (!id || !name) return malformed('empty tool identity');
    content = { type: 'tool_use', id, name, input, raw: JSON.stringify(input) };
  } else return malformed(`unsupported response block ${String(native.type)}`);
  return { index, content, closed: false, json: '', hasJson: false };
}

/** Validate the Messages event lifecycle before returning any executable tools. */
export async function* translateDshEvents(
  events: AsyncIterable<Record<string, unknown>>, model: string, endpoint: string,
): AsyncGenerator<DshStreamDelta, DshModelResponse> {
  const blocks = new Map<number, Block>();
  const usage: DshUsage = { inputTokens: 0, outputTokens: 0 };
  let started = false;
  let reason: 'end_turn' | 'tool_use' | 'max_tokens' | undefined;
  for await (const event of events) {
    if (event.type === 'message_start') {
      if (started) return malformed('duplicate message_start');
      updateUsage(usage, object(event.message).usage); started = true; continue;
    }
    if (!['content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'].includes(String(event.type))) continue;
    if (!started) return malformed('event precedes message_start');
    if (event.type === 'content_block_start') {
      const index = blockIndex(event);
      if (blocks.has(index) || reason !== undefined) return malformed('block starts after settlement or repeats an index');
      const block = startBlock(event, blocks.size);
      blocks.set(index, block);
      const content = block.content;
      if (content.type === 'tool_use') yield { type: 'tool', index: block.index, id: content.id, name: content.name, argumentsDelta: '' };
      else if (content.type === 'text' && content.text) yield { type: 'text', index: block.index, text: content.text };
      else if (content.type === 'thinking' && content.thinking) yield { type: 'reasoning', index: block.index, text: content.thinking };
    } else if (event.type === 'content_block_delta' || event.type === 'content_block_stop') {
      const block = blocks.get(blockIndex(event));
      if (!block || block.closed || reason !== undefined) return malformed('delta/stop without an open block');
      if (event.type === 'content_block_stop') { block.closed = true; continue; }
      const delta = object(event.delta), content = block.content;
      if (delta.type === 'text_delta' && content.type === 'text') {
        const text = string(delta.text); content.text += text; yield { type: 'text', index: block.index, text };
      } else if (delta.type === 'thinking_delta' && content.type === 'thinking') {
        const text = string(delta.thinking); content.thinking += text; yield { type: 'reasoning', index: block.index, text };
      } else if (delta.type === 'signature_delta' && content.type === 'thinking') {
        content.signature = (content.signature ?? '') + string(delta.signature);
      } else if (delta.type === 'input_json_delta' && content.type === 'tool_use') {
        const argumentsDelta = string(delta.partial_json); block.hasJson = true; block.json += argumentsDelta;
        yield { type: 'tool', index: block.index, id: content.id, argumentsDelta };
      } else return malformed(`unsupported delta ${String(delta.type)} for ${content.type}`);
    } else if (event.type === 'message_delta') {
      const delta = object(event.delta);
      if (delta.stop_reason != null) {
        if (reason !== undefined) return malformed('duplicate stop reason');
        if (delta.stop_reason === 'end_turn' || delta.stop_reason === 'stop_sequence') reason = 'end_turn';
        else if (delta.stop_reason === 'tool_use' || delta.stop_reason === 'max_tokens') reason = delta.stop_reason;
        else return malformed(`unsupported stop reason ${String(delta.stop_reason)}`);
      }
      if (event.usage !== undefined) updateUsage(usage, event.usage);
    } else {
      if (!reason) return malformed('message_stop without a stop reason');
      const hasTool = [...blocks.values()].some((block) => block.content.type === 'tool_use');
      if (reason === 'max_tokens' && hasTool) throw new DeepSeekMessagesError('DeepSeek Messages truncated a tool call', 'TRUNCATED_TOOL_CALL');
      if ([...blocks.values()].some((block) => !block.closed)) return malformed('message_stop with open blocks');
      if (reason === 'tool_use' !== hasTool) return malformed('stop reason does not match tool calls');
      if (!blocks.size && reason === 'end_turn') throw new DeepSeekMessagesError('DeepSeek Messages returned no content', 'EMPTY_RESPONSE');
      const content: ContentPart[] = [], toolCalls: ToolCall[] = [], replay: DshReplayBlock[] = [];
      const ids = new Set<string>();
      for (const block of blocks.values()) {
        const part = block.content;
        if (part.type === 'text') { if (part.text) content.push({ type: 'text', text: part.text }); }
        if (part.type === 'tool_use') {
          if (ids.has(part.id)) return malformed('duplicate tool call id');
          ids.add(part.id);
          const raw = block.hasJson ? block.json : part.raw;
          let input: unknown;
          try { input = JSON.parse(raw); } catch { return malformed('tool input is invalid JSON'); }
          part.input = object(input); part.raw = raw;
          toolCalls.push({ id: part.id, name: part.name, arguments: part.input, raw });
        }
        replay.push(part);
      }
      return { message: { role: 'assistant', content, toolCalls,
        dshReplay: { kind: 'deepseek-messages', version: 1, provider: 'deepseek-official', model,
          endpoint: replayEndpointHash(endpoint), blocks: replay } },
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }, dshUsage: usage, stopReason: reason };
    }
  }
  throw new DeepSeekMessagesError('DeepSeek Messages stream ended before message_stop', 'STREAM_CLOSED');
}
