/*
 * Transport adapted from DeepSeek Harness llm-deepseek/src/adapter.ts and messages-api.ts.
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
import type { ModelClient, ModelRequest, ModelStreamDelta } from './types';
import { DSH_BASE_URL, DSH_STREAM_IDLE_TIMEOUT_MS, DeepSeekMessagesError } from './dsh-messages-types';
import type { DeepSeekMessagesOptions, DshModelResponse, DshStreamDelta } from './dsh-messages-types';
import { serializeDshRequest } from './dsh-messages-serialize';
import { parseDshSse, providerError, translateDshEvents, waitForActivity } from './dsh-messages-stream';

export * from './dsh-messages-types';
export { serializeDshRequest } from './dsh-messages-serialize';

export function dshMessagesEndpoint(baseURL: string): string {
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new DeepSeekMessagesError('DeepSeek Messages baseURL is invalid', 'INVALID_CONFIG'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new DeepSeekMessagesError('DeepSeek Messages baseURL must be an HTTP(S) root without credentials, query, or fragment', 'INVALID_CONFIG');
  }
  const base = baseURL.replace(/\/+$/u, '');
  return `${url.pathname.replace(/\/+$/u, '').endsWith('/v1') ? base : `${base}/v1`}/messages`;
}

/** Direct official DeepSeek Messages client without a Cordis runtime. */
export class DeepSeekMessagesModel implements ModelClient {
  readonly name = 'deepseek-official';
  private readonly options: DeepSeekMessagesOptions;
  private readonly endpoint: string;
  private readonly idleMs: number;

  constructor(options: DeepSeekMessagesOptions = {}) {
    this.options = { ...options, ...(options.headers ? { headers: { ...options.headers } } : {}) };
    this.endpoint = dshMessagesEndpoint(options.baseURL ?? process.env['DEEPSEEK_BASE_URL'] ?? DSH_BASE_URL);
    this.idleMs = options.streamIdleTimeoutMs ?? DSH_STREAM_IDLE_TIMEOUT_MS;
    if (!Number.isFinite(this.idleMs) || this.idleMs <= 0 || this.idleMs > 2_147_483_647) {
      throw new DeepSeekMessagesError('DeepSeek Messages streamIdleTimeoutMs must be positive and finite', 'INVALID_CONFIG');
    }
  }
  async complete(request: ModelRequest): Promise<DshModelResponse> {
    const stream = this.streamDetailed(request);
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    return next.value;
  }
  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamDelta, DshModelResponse> {
    const stream = this.streamDetailed(request);
    try {
      let next = await stream.next();
      while (!next.done) {
        if (next.value.type === 'text') yield { type: 'text', text: next.value.text };
        else if (next.value.type === 'reasoning') yield { type: 'reasoning', text: next.value.text };
        next = await stream.next();
      }
      return next.value;
    } finally { await stream.return(undefined as never); }
  }
  /** Extended stream for consumers able to handle reasoning and tool fragments. */
  async *streamDetailed(request: ModelRequest): AsyncGenerator<DshStreamDelta, DshModelResponse> {
    const controller = new AbortController();
    const signal = request.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, request.signal]);
    try {
      if (signal.aborted) throw new DeepSeekMessagesError('DeepSeek Messages request aborted', 'ABORTED');
      const apiKey = this.options.apiKey ?? process.env['DEEPSEEK_API_KEY'];
      if (!apiKey) throw new DeepSeekMessagesError('DeepSeek Messages requires DEEPSEEK_API_KEY or apiKey', 'MISSING_CREDENTIAL');
      const body = serializeDshRequest(request, this.options, this.endpoint);
      const headers = new Headers(this.options.headers);
      headers.set('content-type', 'application/json'); headers.set('accept', 'text/event-stream');
      headers.set('x-api-key', apiKey); headers.set('anthropic-version', '2023-06-01');
      const response = await waitForActivity((this.options.fetch ?? fetch)(this.endpoint, {
        method: 'POST', signal, redirect: 'error', headers, body: JSON.stringify(body),
      }), signal, this.idleMs, controller);
      if (!response.ok) {
        const raw = await waitForActivity(response.text(), signal, this.idleMs, controller);
        let value: unknown;
        try { value = JSON.parse(raw); } catch { value = undefined; }
        throw providerError(value, response.status, response.headers);
      }
      if (!response.body) throw new DeepSeekMessagesError('DeepSeek Messages returned no response body', 'EMPTY_RESPONSE');
      return yield* translateDshEvents(parseDshSse(response.body, signal, this.idleMs, controller), request.model, this.endpoint);
    } catch (error) {
      if (error instanceof DeepSeekMessagesError) throw error;
      if (request.signal?.aborted) throw new DeepSeekMessagesError('DeepSeek Messages request aborted', 'ABORTED', { cause: error });
      throw new DeepSeekMessagesError('DeepSeek Messages transport failed', 'TRANSPORT', { cause: error });
    } finally { controller.abort(); }
  }
}
