import type { Message } from '../domain/message';
import { text } from '../domain/message';

export interface CompactionOptions {
  maxTokens: number;
  retainTokens?: number;
  summarize?: (messages: readonly Message[]) => Promise<string>;
}

export interface CompactionResult {
  messages: Message[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
  removed: Message[];
}

/** A conservative, provider-independent estimate: JSON UTF-8 bytes / 4. */
export function estimateMessageTokens(message: Message): number {
  return Math.max(1, Math.ceil(new TextEncoder().encode(JSON.stringify(message)).length / 4));
}

export function estimateMessages(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export async function compactMessages(
  input: readonly Message[],
  options: CompactionOptions,
): Promise<CompactionResult> {
  const messages = input.map((message) => structuredClone(message));
  const beforeTokens = estimateMessages(messages);
  if (beforeTokens <= options.maxTokens) {
    return { messages, compacted: false, beforeTokens, afterTokens: beforeTokens, removed: [] };
  }

  const retainTokens = Math.max(0, options.retainTokens ?? Math.floor(options.maxTokens * 0.25));
  const groups: Message[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index];
    if (!current) continue;
    const next = messages[index + 1];
    if (current.role === 'assistant' && current.toolCalls.length > 0 && next?.role === 'tool') {
      groups.push([current, next]);
      index += 1;
    } else {
      groups.push([current]);
    }
  }

  let groupStart = groups.length;
  let retainedTokens = 0;
  while (groupStart > 0 && retainedTokens < retainTokens) {
    const group = groups[groupStart - 1];
    if (!group) break;
    retainedTokens += estimateMessages(group);
    groupStart -= 1;
  }
  while (groupStart < groups.length && estimateMessages(groups.slice(groupStart).flat()) > options.maxTokens) {
    groupStart += 1;
  }

  const removed = groups.slice(0, groupStart).flat();
  const retainedMessages = groups.slice(groupStart).flat();
  if (removed.length === 0) {
    // Even the oldest group cannot be dropped. Returning "compacted" here
    // would prepend a summary to the unchanged history and grow the request.
    return { messages, compacted: false, beforeTokens, afterTokens: beforeTokens, removed: [] };
  }

  const summary = options.summarize
    ? await options.summarize(removed)
    : `Earlier conversation compacted (${removed.length} messages).`;
  const compactedMessages = [
    { role: 'user' as const, content: [text(`[conversation summary]\n${summary}`)] },
    ...retainedMessages,
  ];
  const afterTokens = estimateMessages(compactedMessages);
  if (afterTokens >= beforeTokens) {
    // A summary that does not reduce the request must not be reported as
    // compaction. Returning the original copy keeps the caller's context
    // finite instead of silently growing it. A reduced request may still
    // exceed the configured budget when no smaller group can be retained.
    return { messages, compacted: false, beforeTokens, afterTokens: beforeTokens, removed: [] };
  }

  return {
    messages: compactedMessages,
    compacted: true,
    beforeTokens,
    afterTokens,
    removed,
  };
}
