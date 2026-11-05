/*
 * Adapted from DeepSeek Harness llm-deepseek/src/{serialize,replay}.ts.
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
import { isDeepStrictEqual } from 'node:util';
import type { AssistantMessage, ContentPart, ToolCall } from '../domain/message';
import type { ModelRequest } from './types';
import { DeepSeekMessagesError, DSH_BASE_URL, DSH_MAX_TOKENS } from './dsh-messages-types';
import { replayEndpointHash } from './replay-identity';
import type { DshReplayBlock, DshRequestOptions, DshWireBlock, DshWireInput, DshWireMessage, DshWireRequest } from './dsh-messages-types';

function invalid(message: string): never { throw new DeepSeekMessagesError(message, 'INVALID_REQUEST'); }
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function historicalInput(call: ToolCall): Record<string, unknown> {
  if (call.raw !== undefined) {
    try { const value: unknown = JSON.parse(call.raw); return isObject(value) ? value : {}; } catch { return {}; }
  }
  return isObject(call.arguments) ? call.arguments : {};
}
function inputs(parts: ContentPart[]): DshWireInput[] {
  return parts.flatMap((part): DshWireInput[] => {
    if (part.type === 'text') return part.text ? [{ type: 'text', text: part.text }] : [];
    if (part.type === 'image') return [{ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } }];
    return invalid('DeepSeek Messages cannot represent this input content');
  });
}

/** Use native replay only if its identity and visible projection still match the message. */
function replayBlocks(message: AssistantMessage, model: string, endpoint?: string): DshWireBlock[] | undefined {
  const targetEndpoint = endpoint ?? `${DSH_BASE_URL}/v1/messages`;
  const replay: unknown = (message as AssistantMessage & { dshReplay?: unknown }).dshReplay;
  if (!isObject(replay) || replay.kind !== 'deepseek-messages' || replay.version !== 1
    || replay.provider !== 'deepseek-official' || replay.model !== model
    || replay.endpoint !== replayEndpointHash(targetEndpoint)
    || !Array.isArray(replay.blocks)) return undefined;
  const blocks: DshReplayBlock[] = [];
  for (const item of replay.blocks as unknown[]) {
    if (!isObject(item)) return undefined;
    if (item.type === 'text' && typeof item.text === 'string') blocks.push({ type: 'text', text: item.text });
    else if (item.type === 'thinking' && typeof item.thinking === 'string'
      && (item.signature === undefined || typeof item.signature === 'string')) {
      blocks.push({ type: 'thinking', thinking: item.thinking, ...(item.signature === undefined ? {} : { signature: item.signature }) });
    } else if (item.type === 'tool_use' && typeof item.id === 'string' && item.id && typeof item.name === 'string' && item.name
      && typeof item.raw === 'string' && isObject(item.input)) {
      let parsed: unknown;
      try { parsed = JSON.parse(item.raw); } catch { return undefined; }
      if (!isObject(parsed) || !isDeepStrictEqual(parsed, item.input)) return undefined;
      blocks.push({ type: 'tool_use', id: item.id, name: item.name, input: item.input, raw: item.raw });
    } else return undefined;
  }
  const texts = blocks.flatMap((block) => block.type === 'text' && block.text ? [{ type: 'text', text: block.text }] : []);
  const calls = blocks.flatMap((block) => block.type === 'tool_use'
    ? [{ id: block.id, name: block.name, arguments: block.input, raw: block.raw }] : []);
  if (!isDeepStrictEqual(texts, message.content.filter((part) => part.type !== 'text' || part.text))
    || !isDeepStrictEqual(calls, message.toolCalls)) return undefined;
  return blocks.flatMap((block): DshWireBlock[] => {
    if (block.type === 'text') return block.text ? [{ type: 'text', text: block.text }] : [];
    if (block.type === 'thinking') return [{ ...block }];
    return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }];
  });
}
function assistantBlocks(message: AssistantMessage, model: string, endpoint?: string): DshWireBlock[] {
  const replay = replayBlocks(message, model, endpoint);
  if (replay) return replay;
  const text: DshWireBlock[] = [];
  for (const part of message.content) {
    if (part.type !== 'text') return invalid('DeepSeek Messages cannot represent assistant image content');
    if (part.text) text.push({ type: 'text', text: part.text });
  }
  return [...text, ...message.toolCalls.map((call): DshWireBlock => {
    if (!call.id || !call.name) return invalid('DeepSeek Messages tool call has empty identity');
    return { type: 'tool_use', id: call.id, name: call.name, input: historicalInput(call) };
  })];
}

/** Project OmniAgent messages into the native Messages request without mutating history. */
export function serializeDshRequest(
  request: ModelRequest, options: DshRequestOptions = {}, endpoint?: string,
): DshWireRequest {
  const maxTokens = options.maxTokens ?? DSH_MAX_TOKENS;
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) return invalid('DeepSeek Messages maxTokens must be a positive safe integer');
  const effort = options.reasoningEffort ?? 'high';
  if (!['off', 'low', 'high', 'max'].includes(effort)) return invalid('DeepSeek Messages unsupported reasoning effort');
  if (!request.model) return invalid('DeepSeek Messages model must be non-empty');
  const inHistory = (options.systemPromptUpdate ?? (request.model === 'deepseek-flash' ? 'in-history' : 'latest')) === 'in-history';
  const messages: DshWireMessage[] = [];
  let historySystem: string | undefined;
  const updates: DshWireMessage[] = [];
  const flush = () => {
    if (!updates.length) return;
    if (messages.at(-1)?.role !== 'user') return invalid('DeepSeek Messages system update requires preceding user or tool results');
    messages.push(...updates.splice(0));
  };
  for (const message of request.messages) {
    if (message.role === 'system') {
      if (inHistory && messages.length) {
        if (!message.content) return invalid('DeepSeek Messages cannot represent an empty system update');
        updates.push({ role: 'system', content: [{ type: 'text', text: message.content }] });
      } else historySystem = message.content;
      continue;
    }
    let content: DshWireBlock[];
    if (message.role === 'assistant') content = assistantBlocks(message, request.model, endpoint);
    else if (message.role === 'user') content = inputs(message.content);
    else content = message.results.map((result) => ({
      type: 'tool_result', tool_use_id: result.callId,
      content: result.content ? [{ type: 'text', text: result.content }] : [], is_error: !result.ok,
    }));
    if (!content.length) continue;
    if (message.role === 'assistant') flush();
    const role = message.role === 'tool' ? 'user' : message.role;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  }
  flush();
  let pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (pending.size) return invalid('DeepSeek Messages tool calls need immediate results');
      const calls = message.content.filter((block) => block.type === 'tool_use');
      pending = new Set(calls.map((call) => call.id));
      if (pending.size !== calls.length) return invalid('DeepSeek Messages duplicate tool call id');
    } else if (message.role === 'user') {
      const results = message.content.filter((block) => block.type === 'tool_result');
      for (const result of results) if (!pending.delete(result.tool_use_id)) return invalid('DeepSeek Messages tool result has no matching call');
      if (pending.size) return invalid('DeepSeek Messages tool calls need immediate results');
      message.content = [...results, ...message.content.filter((block) => block.type !== 'tool_result')];
    }
  }
  if (pending.size) return invalid('DeepSeek Messages history ends with unresolved tool calls');
  const system = [request.system, historySystem].filter(Boolean).join('\n\n');
  return {
    model: request.model, stream: true, max_tokens: maxTokens, messages,
    thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
    ...(effort === 'off' ? {} : { output_config: { effort } }),
    ...(system ? { system } : {}),
    ...(request.tools.length ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
  };
}
