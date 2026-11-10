import type { Message } from '../domain/message';
import { text } from '../domain/message';

export interface CompactionOptions {
  maxTokens: number;
  retainTokens?: number;
  summarize?: (messages: readonly Message[]) => Promise<string>;
  /** Estimate the actual model-facing messages while retaining original history. */
  project?: (messages: readonly Message[]) => Message[];
  /** Input indices that must survive compaction, even when they exceed the budget. */
  protectedIndices?: readonly number[];
}

export interface CompactionResult {
  messages: Message[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
  removed: Message[];
  /** Updated protected indices after a successful compaction. */
  protectedIndices?: number[];
}

// Without image dimensions or provider-specific tiling, use a fixed approximate
// visual cost per image. Base64 transport size is not a text token count.
const IMAGE_TOKENS = 1024;

/** Provider-independent estimate: JSON UTF-8 bytes / 4 plus a visual allowance. */
export function estimateMessageTokens(message: Message): number {
  // Metering metadata is persisted for replay but is never sent to a provider.
  const value = message.role === 'assistant'
    ? (({ usage: _usage, contextSample: _sample, ...rest }) => rest)(message)
    : message;
  let imageCount = 0;
  const projected = value.role === 'user' || value.role === 'assistant'
    ? { ...value, content: value.content.map((part) => {
      if (part.type !== 'image') return part;
      imageCount += 1;
      return { ...part, data: '' };
    }) }
    : value;
  return Math.max(1, Math.ceil(new TextEncoder().encode(JSON.stringify(projected)).length / 4) + imageCount * IMAGE_TOKENS);
}

export function estimateMessages(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export async function compactMessages(
  input: readonly Message[],
  options: CompactionOptions,
): Promise<CompactionResult> {
  const messages = input.map((message) => structuredClone(message));
  const estimate = (items: readonly Message[]) => estimateMessages(options.project ? options.project(items) : items);
  const beforeTokens = estimate(messages);
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

  const protectedIndices = new Set(options.protectedIndices ?? []);
  let messageIndex = 0;
  const protectedGroups = groups.map((group) => {
    const isProtected = group.some((_, offset) => protectedIndices.has(messageIndex + offset));
    messageIndex += group.length;
    return isProtected;
  });

  let groupStart = groups.length;
  let retainedTokens = 0;
  while (groupStart > 0 && retainedTokens < retainTokens) {
    const group = groups[groupStart - 1];
    if (!group) break;
    retainedTokens += estimate(group);
    groupStart -= 1;
  }
  while (groupStart < groups.length && estimate(groups
    .filter((_, index) => index >= groupStart || protectedGroups[index]).flat()) > options.maxTokens) {
    groupStart += 1;
  }

  const removed = groups.filter((_, index) => index < groupStart && !protectedGroups[index]).flat();
  const retainedMessages = groups.filter((_, index) => index >= groupStart || protectedGroups[index]).flat();
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
  const afterTokens = estimate(compactedMessages);
  if (afterTokens >= beforeTokens) {
    // A summary that does not reduce the request must not be reported as
    // compaction. Returning the original copy keeps the caller's context
    // finite instead of silently growing it. A reduced request may still
    // exceed the configured budget when no smaller group can be retained.
    return { messages, compacted: false, beforeTokens, afterTokens: beforeTokens, removed: [] };
  }

  const retainedProtectedIndices: number[] = [];
  let originalIndex = 0;
  let retainedIndex = 1; // The summary is inserted at the start.
  groups.forEach((group, index) => {
    const retained = index >= groupStart || protectedGroups[index];
    group.forEach(() => {
      if (retained && protectedIndices.has(originalIndex)) retainedProtectedIndices.push(retainedIndex);
      originalIndex += 1;
      if (retained) retainedIndex += 1;
    });
  });
  return {
    messages: compactedMessages,
    compacted: true,
    beforeTokens,
    afterTokens,
    removed,
    ...(options.protectedIndices ? { protectedIndices: retainedProtectedIndices } : {}),
  };
}
