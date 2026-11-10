import { z } from 'zod';

/**
 * 领域数据模型：只描述「数据长什么样」，不含任何行为。
 *
 * 这些类型是持久化的单位（transcript 落盘）也是发给模型的单位，
 * 所以尽量用 zod schema 定义、再用 z.infer 导出类型，避免手写两份漂移。
 */

export const ContentPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
    /** Display metadata for a model-facing attachment path, persisted with the text. */
    attachment: z.object({
      kind: z.enum(['file', 'image']),
      name: z.string(),
      mediaType: z.string(),
      filePath: z.string(),
    }).optional(),
  }),
  z.object({
    type: z.literal('image'),
    mediaType: z.string(),
    data: z.string(),
    fileName: z.string().optional(),
    /** Readable storage path relative to the session cwd. */
    filePath: z.string().optional(),
  }),
]);
export type ContentPart = z.infer<typeof ContentPartSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 已解析的参数。原始 JSON 串留在 raw 里，便于排查模型输出格式问题。 */
  arguments: z.unknown(),
  raw: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultSchema = z.object({
  callId: z.string(),
  name: z.string(),
  ok: z.boolean(),
  /** 回灌给模型的文本，已截断。 */
  content: z.string(),
  truncated: z.boolean().default(false),
  durationMs: z.number().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Input tokens read from cache; absent when cache usage is unknown. */
  cachedInputTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const SystemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.string(),
});
export type SystemMessage = z.infer<typeof SystemMessageSchema>;

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.array(ContentPartSchema),
  initCommand: z.literal(true).optional(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

const REPLAY_MAX_IDENTIFIER_LENGTH = 1024;
const REPLAY_MAX_TEXT_LENGTH = 4 * 1024 * 1024;
const REPLAY_MAX_BLOCKS = 1024;
const REPLAY_MAX_JSON_NODES = 100_000;
const REPLAY_MAX_JSON_DEPTH = 64;

const replayIdentifier = z.string().min(1).max(REPLAY_MAX_IDENTIFIER_LENGTH);
const replayText = z.string().max(REPLAY_MAX_TEXT_LENGTH);

type ReplayJsonValue = null | boolean | number | string | ReplayJsonValue[] | { [key: string]: ReplayJsonValue };

// Validate iteratively before accepting untrusted tool inputs from a session log.
function isBoundedJsonObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const pending: Array<{ value: unknown; depth: number; exiting?: boolean }> = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  let characters = 0;

  while (pending.length > 0) {
    const item = pending.pop()!;
    if (item.exiting) {
      ancestors.delete(item.value as object);
      continue;
    }
    if (++nodes > REPLAY_MAX_JSON_NODES || item.depth > REPLAY_MAX_JSON_DEPTH) return false;
    const current = item.value;
    if (current === null || typeof current === 'boolean') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current === 'string') {
      characters += current.length;
      if (characters > REPLAY_MAX_TEXT_LENGTH) return false;
      continue;
    }
    if (typeof current !== 'object' || ancestors.has(current)) return false;
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype &&
        Object.getPrototypeOf(current) !== null) return false;
    if (Object.getOwnPropertySymbols(current).length > 0) return false;
    ancestors.add(current);
    pending.push({ value: current, depth: item.depth, exiting: true });
    for (const [key, child] of Object.entries(current)) {
      characters += key.length;
      if (characters > REPLAY_MAX_TEXT_LENGTH) return false;
      pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return true;
}

const DshReplayInputSchema = z.record(z.string(), z.unknown()).refine(isBoundedJsonObject);
const PiReplayArgumentsSchema = z.custom<{ [key: string]: ReplayJsonValue }>(isBoundedJsonObject);

export const DshReplaySchema = z.object({
  kind: z.literal('deepseek-messages'),
  version: z.literal(1),
  provider: z.literal('deepseek-official'),
  model: replayIdentifier,
  endpoint: replayIdentifier.optional(),
  blocks: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: replayText }).strict(),
    z.object({ type: z.literal('thinking'), thinking: replayText, signature: replayText.optional() }).strict(),
    z.object({
      type: z.literal('tool_use'), id: replayIdentifier, name: replayIdentifier,
      input: DshReplayInputSchema, raw: replayText,
    }).strict(),
  ])).max(REPLAY_MAX_BLOCKS),
}).strict();
export type DshReplay = z.infer<typeof DshReplaySchema>;

export const ProviderReplaySchema = z.object({
  kind: z.literal('pi-ai'),
  version: z.literal(1),
  provider: replayIdentifier,
  model: replayIdentifier,
  api: replayIdentifier,
  endpoint: replayIdentifier.optional(),
  responseModel: replayIdentifier.optional(),
  responseId: replayIdentifier.optional(),
  providerThinkingLevel: replayIdentifier.optional(),
  stopReason: z.enum(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']).optional(),
  content: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: replayText, textSignature: replayText.optional() }).strict(),
    z.object({
      type: z.literal('thinking'), thinking: replayText,
      thinkingSignature: replayText.optional(), redacted: z.boolean().optional(),
    }).strict(),
    z.object({
      type: z.literal('toolCall'), id: replayIdentifier, name: replayIdentifier,
      arguments: PiReplayArgumentsSchema, thoughtSignature: replayText.optional(),
      namespace: replayIdentifier.optional(),
    }).strict(),
  ])).max(REPLAY_MAX_BLOCKS),
}).strict();
export type ProviderReplay = z.infer<typeof ProviderReplaySchema>;

export const AssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.array(ContentPartSchema),
  toolCalls: z.array(ToolCallSchema).default([]),
  usage: UsageSchema.optional(),
  /** Elapsed time for this model request, including streaming, in milliseconds. */
  requestDurationMs: z.number().nonnegative().optional(),
  contextSample: z.object({
    provider: z.string(), model: z.string(), historyHash: z.string(),
    systemTokens: z.number().int().nonnegative(), toolsTokens: z.number().int().nonnegative(),
    messageTokens: z.number().int().nonnegative(),
  }).strict().optional(),
  dshReplay: DshReplaySchema.optional(),
  providerReplay: ProviderReplaySchema.optional(),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

export const ToolMessageSchema = z.object({
  role: z.literal('tool'),
  results: z.array(ToolResultSchema),
});
export type ToolMessage = z.infer<typeof ToolMessageSchema>;

export const MessageSchema = z.discriminatedUnion('role', [
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
]);
export type Message = z.infer<typeof MessageSchema>;

export const text = (value: string): ContentPart => ({ type: 'text', text: value });

export const userMessage = (value: string): UserMessage => ({
  role: 'user',
  content: [text(value)],
});

/** 把 assistant 消息里的文本拼起来，给 TUI 显示用。 */
export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
