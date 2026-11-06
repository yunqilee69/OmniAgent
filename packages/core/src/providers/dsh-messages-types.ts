import type { AssistantMessage, Usage } from '../domain/message';
import type { ModelReasoning } from '../config/models';
import type { ModelResponse } from './types';

export const DEFAULT_DSH_MODEL = 'deepseek-flash';
export const DSH_BASE_URL = 'https://api.deepseek.com/anthropic';
export const DSH_MAX_TOKENS = 256_000;
export const DSH_STREAM_IDLE_TIMEOUT_MS = 300_000;

export type DshReasoningEffort = 'off' | 'low' | 'high' | 'max';
export type DshReplayBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; raw: string };

/** Persist on the assistant message; never put credentials in replay metadata. */
export interface DshReplay {
  kind: 'deepseek-messages';
  version: 1;
  provider: 'deepseek-official';
  model: string;
  endpoint: string;
  blocks: DshReplayBlock[];
}
export type DshAssistantMessage = AssistantMessage & { dshReplay: DshReplay };
export interface DshUsage extends Usage { cacheReadTokens?: number; cacheWriteTokens?: number }
export interface DshModelResponse extends ModelResponse { message: DshAssistantMessage; dshUsage: DshUsage }
export type DshStreamDelta =
  | { type: 'text' | 'reasoning'; index: number; text: string }
  | { type: 'tool'; index: number; id: string; name?: string; argumentsDelta: string };

export interface DshRequestOptions {
  maxTokens?: number;
  reasoningEffort?: DshReasoningEffort;
  reasoning?: ModelReasoning;
  systemPromptUpdate?: 'in-history' | 'latest';
}
export interface DeepSeekMessagesOptions extends DshRequestOptions {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  streamIdleTimeoutMs?: number;
  fetch?: typeof fetch;
}
export type DshWireInput =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type DshWireBlock = DshWireInput
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: DshWireInput[]; is_error: boolean };
export interface DshWireMessage { role: 'user' | 'assistant' | 'system'; content: DshWireBlock[] }
export interface DshWireRequest {
  model: string;
  stream: true;
  max_tokens: number;
  messages: DshWireMessage[];
  thinking: { type: 'enabled' | 'disabled' };
  output_config?: { effort: Exclude<DshReasoningEffort, 'off'> };
  system?: string;
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
}
export class DeepSeekMessagesError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: { status?: number; retryAfterMs?: number; requestId?: string; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'DeepSeekMessagesError';
  }
  get status() { return this.details.status; }
  get retryAfterMs() { return this.details.retryAfterMs; }
  get requestId() { return this.details.requestId; }
}
