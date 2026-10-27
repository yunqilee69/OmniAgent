import { z } from 'zod';

/**
 * 领域数据模型：只描述「数据长什么样」，不含任何行为。
 *
 * 这些类型是持久化的单位（transcript 落盘）也是发给模型的单位，
 * 所以尽量用 zod schema 定义、再用 z.infer 导出类型，避免手写两份漂移。
 */

export const ContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    mediaType: z.string(),
    data: z.string(),
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
  /** 回灌给模型的文本，已截断。完整输出走 fullOutputRef。 */
  content: z.string(),
  truncated: z.boolean().default(false),
  fullOutputRef: z.string().optional(),
  durationMs: z.number().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
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
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

export const AssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.array(ContentPartSchema),
  toolCalls: z.array(ToolCallSchema).default([]),
  usage: UsageSchema.optional(),
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
