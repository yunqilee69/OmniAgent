import { createHash } from 'node:crypto';
import type { AssistantMessage, ContentPart, Message, ToolResult, UserMessage } from '../domain/message';
import {
  AssistantMessageSchema, ContentPartSchema, DshReplaySchema, MessageSchema, ProviderReplaySchema, userMessage,
} from '../domain/message';
import type { SessionEvent } from './types';

export type PublicHistoryMessage = Message & { messageId: string; timestamp: number };

export function projectPublicHistory(identity: unknown, events: readonly SessionEvent[]): PublicHistoryMessage[] {
  const result: PublicHistoryMessage[] = [];
  for (const event of events) {
    const message = projectMessages([event])[0];
    if (message === undefined) continue;
    const safe = safePublicMessages([message])[0]!;
    const previous = result.at(-1);
    if (safe.role === 'tool' && previous?.role === 'tool') {
      previous.results.push(...safe.results);
      continue;
    }
    result.push({
      ...safe,
      messageId: createHash('sha256').update(JSON.stringify([identity, event])).digest('hex'),
      timestamp: event.ts,
    });
  }
  return result;
}

export function projectMessages(events: readonly SessionEvent[]): Message[] {
  const messages: Message[] = [];
  for (const event of events) {
    if (event.type === 'message/user' || event.type === 'user/message' || event.type === 'message/notice') {
      const message = readUserMessage(event.data);
      if (message) messages.push(message);
    } else if (event.type === 'subagent/notice') {
      const message = readSubagentNotice(event.data);
      if (message) messages.push(message);
    } else if (event.type === 'message/assistant' || event.type === 'assistant/message') {
      const message = readAssistantMessage(event.data);
      if (message) messages.push(message);
    } else if (event.type === 'message/tool-result' || event.type === 'tool/result') {
      const result = readToolResult(event.data);
      if (!result) continue;
      const previous = messages.at(-1);
      if (previous?.role === 'tool') previous.results.push(result);
      else messages.push({ role: 'tool', results: [result] });
    }
  }
  return messages;
}

/** Return the public transcript fields only, never provider replay metadata. */
export function safePublicMessages(messages: readonly Message[]): Message[] {
  return messages.map((message): Message => {
    switch (message.role) {
      case 'system':
        return { role: 'system', content: message.content };
      case 'user':
        return { role: 'user', content: message.content.map(publicContentPart) };
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content.map(publicContentPart),
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            ...(call.raw === undefined ? {} : { raw: call.raw }),
          })),
          ...(message.usage === undefined ? {} : {
            usage: { inputTokens: message.usage.inputTokens, outputTokens: message.usage.outputTokens },
          }),
        };
      case 'tool':
        return {
          role: 'tool',
          results: message.results.map((result) => ({
            callId: result.callId,
            name: result.name,
            ok: result.ok,
            content: result.content,
            truncated: result.truncated,
            ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
          })),
        };
    }
  });
}

function publicContentPart(part: ContentPart): ContentPart {
  return part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image', mediaType: part.mediaType, data: part.data };
}

function readAssistantMessage(data: unknown): AssistantMessage | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const dshReplay = DshReplaySchema.safeParse(record.dshReplay);
  const providerReplay = ProviderReplaySchema.safeParse(record.providerReplay);
  const parsed = AssistantMessageSchema.safeParse({
    ...record,
    dshReplay: dshReplay.success ? dshReplay.data : undefined,
    providerReplay: providerReplay.success ? providerReplay.data : undefined,
  });
  if (!parsed.success) return undefined;
  // Avoid adding absent optional properties to legacy messages.
  if (parsed.data.dshReplay === undefined) delete parsed.data.dshReplay;
  if (parsed.data.providerReplay === undefined) delete parsed.data.providerReplay;
  return parsed.data;
}

function readSubagentNotice(data: unknown): UserMessage | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.childId !== 'string' || typeof record.status !== 'string') return undefined;
  const description = typeof record.description === 'string' && record.description.trim()
    ? `\n${record.description.trim()}`
    : '';
  const result = typeof record.result === 'string' && record.result.trim()
    ? `\n\n${record.result.trim()}`
    : '';
  return userMessage(
    `[Subagent ${record.childId} ${record.status}]${description}${result}\n\n`
    + 'Review the result before relying on it; open the child session for full details.',
  );
}

function readUserMessage(data: unknown): UserMessage | undefined {
  if (typeof data === 'string') return userMessage(data);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;

  const record = data as Record<string, unknown>;
  if (record.role !== undefined && record.role !== 'user') return undefined;

  const content = typeof record.text === 'string' ? userMessage(record.text).content : readContent(record.content);
  if (content === undefined) return undefined;
  const parsed = MessageSchema.safeParse({ role: 'user', content });
  return parsed.success && parsed.data.role === 'user' ? parsed.data : undefined;
}

function readContent(value: unknown): ContentPart[] | undefined {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) return undefined;

  const content: ContentPart[] = [];
  for (const part of value) {
    const parsed = ContentPartSchema.safeParse(part);
    if (parsed.success) content.push(parsed.data);
  }
  return value.length === 0 || content.length > 0 ? content : undefined;
}

function readToolResult(data: unknown): ToolResult | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const result = 'result' in record ? record.result : data;
  if (typeof result !== 'object' || result === null) return undefined;
  const candidate = result as Partial<ToolResult>;
  if (typeof candidate.callId !== 'string' || typeof candidate.name !== 'string' ||
      typeof candidate.ok !== 'boolean' || typeof candidate.content !== 'string') return undefined;
  return {
    callId: candidate.callId,
    name: candidate.name,
    ok: candidate.ok,
    content: candidate.content,
    truncated: candidate.truncated ?? false,
    ...(candidate.durationMs === undefined ? {} : { durationMs: candidate.durationMs }),
  };
}
