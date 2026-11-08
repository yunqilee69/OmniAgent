/**
 * Log-backed session titles.
 *
 * A title is a `session/title` event on the session log, so it survives
 * replay, resume and pagination like any other event. The latest event wins.
 * Titles are client-visible state only: they never enter the model history.
 *
 * The deterministic fallback is derived locally from the first eligible human
 * message. An optional model-backed title can replace it later without ever
 * blocking the agent turn.
 */

import type { ModelClient } from '../providers/types';
import { SESSION_PIN_EVENT } from './pin';
import type { SessionEvent } from './types';

export const SESSION_TITLE_EVENT = 'session/title';

export interface SessionTitleSourceFallback {
  readonly kind: 'fallback';
}

export interface SessionTitleSourceProvider {
  readonly kind: 'provider';
  readonly provider: string;
  readonly model?: SessionTitleModelIdentity;
}

export interface SessionTitleSourceUser {
  /** Explicit user rename: pins the title and stops automatic generation. */
  readonly kind: 'user';
}

export type SessionTitleSource =
  | SessionTitleSourceFallback
  | SessionTitleSourceProvider
  | SessionTitleSourceUser;

export interface SessionTitleModelIdentity {
  readonly provider: string;
  readonly model: string;
}

export interface SessionTitleEventData {
  readonly title: string;
  /** Exact human message seqs used to derive this title; empty for a user rename. */
  readonly messageSeqs: readonly number[];
  readonly source: SessionTitleSource;
}

export interface SessionTitleSnapshot extends SessionTitleEventData {
  readonly eventSeq: number;
  readonly updatedAt: number;
}

/** One eligible human text message exposed to title generation. */
export interface SessionTitleMessage {
  readonly seq: number;
  readonly text: string;
}

export interface SessionTitleLimits {
  readonly fallbackMaxWords: number;
  readonly fallbackMaxBytes: number;
  readonly maxTitleBytes: number;
}

/** Required deterministic fallback limits and accepted-title byte budget. */
export const DEFAULT_SESSION_TITLE_LIMITS: SessionTitleLimits = Object.freeze({
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
});

export interface SessionTitleLlmOptions {
  /** Maximum UTF-8 bytes in the prepared title-request user input. */
  readonly maxInputBytes?: number;
  /** Output-token ceiling for the auxiliary title request. */
  readonly maxOutputTokens?: number;
  /** End-to-end auxiliary request deadline in milliseconds. */
  readonly timeoutMs?: number;
  /** Target word count for non-CJK titles. */
  readonly targetWords?: number;
  /** Target character count for CJK titles. */
  readonly targetCjkCharacters?: number;
}

export const DEFAULT_SESSION_TITLE_LLM_OPTIONS: Required<SessionTitleLlmOptions> = Object.freeze({
  maxInputBytes: 4_096,
  maxOutputTokens: 4_096,
  timeoutMs: 60_000,
  targetWords: 5,
  targetCjkCharacters: 10,
});

/**
 * Optional title generation for one live Session.
 *
 * Omitting this whole object keeps the session title-free (useful for tests and
 * subagents). Passing it with only limits yields the local fallback; passing a
 * model/modelId additionally enables one asynchronous model title attempt.
 */
export interface SessionTitleOptions extends Partial<SessionTitleLimits> {
  readonly model?: ModelClient;
  readonly modelId?: string;
  /** Audit label for the route; defaults to the ModelClient name. */
  readonly provider?: string;
  readonly llm?: SessionTitleLlmOptions | false;
}

/** Resolve title limits with defaults and validate every value. */
export function resolveSessionTitleLimits(
  options: SessionTitleOptions | undefined,
): SessionTitleLimits {
  const candidate = {
    fallbackMaxWords: options?.fallbackMaxWords ?? DEFAULT_SESSION_TITLE_LIMITS.fallbackMaxWords,
    fallbackMaxBytes: options?.fallbackMaxBytes ?? DEFAULT_SESSION_TITLE_LIMITS.fallbackMaxBytes,
    maxTitleBytes: options?.maxTitleBytes ?? DEFAULT_SESSION_TITLE_LIMITS.maxTitleBytes,
  };
  for (const [name, value] of Object.entries(candidate)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`session title: ${name} must be a positive integer`);
    }
  }
  if (candidate.fallbackMaxBytes > candidate.maxTitleBytes) {
    throw new Error('session title: fallbackMaxBytes must not exceed maxTitleBytes');
  }
  return candidate;
}

/** Resolve optional model-title settings; false disables the model call. */
export function resolveSessionTitleLlmOptions(
  options: SessionTitleOptions,
): Required<SessionTitleLlmOptions> | undefined {
  if (options.llm === false || options.model === undefined || options.modelId === undefined) {
    return undefined;
  }
  const resolved = {
    maxInputBytes: options.llm?.maxInputBytes ?? DEFAULT_SESSION_TITLE_LLM_OPTIONS.maxInputBytes,
    maxOutputTokens: options.llm?.maxOutputTokens ?? DEFAULT_SESSION_TITLE_LLM_OPTIONS.maxOutputTokens,
    timeoutMs: options.llm?.timeoutMs ?? DEFAULT_SESSION_TITLE_LLM_OPTIONS.timeoutMs,
    targetWords: options.llm?.targetWords ?? DEFAULT_SESSION_TITLE_LLM_OPTIONS.targetWords,
    targetCjkCharacters: options.llm?.targetCjkCharacters ?? DEFAULT_SESSION_TITLE_LLM_OPTIONS.targetCjkCharacters,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`session title: llm.${name} must be a positive integer`);
    }
  }
  if (options.modelId.trim().length === 0) {
    throw new Error('session title: modelId must be a non-empty string');
  }
  return resolved;
}

/** Operating-system-command escape sequences, including unterminated tails. */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu;
/** Control-sequence-introducer escapes such as SGR color codes. */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu;
/** Remaining two-byte ESC control sequences. */
const ESC_SEQUENCE = /\u001B[@-_]/gu;
/** Non-whitespace C0/C1 control characters. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
/** Directional and invisible controls that can make a displayed title deceptive. */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

/** Remove controls and produce one trimmed, whitespace-normalized line. */
function cleanTitleText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Truncate a string to a UTF-8 byte budget without splitting a Unicode code point.
 * @param input - normalized title text.
 * @param maxBytes - positive UTF-8 byte budget.
 * @returns the longest leading code-point prefix within the budget.
 */
export function truncateTitleUtf8(input: string, maxBytes: number): string {
  assertPositiveInteger('maxBytes', maxBytes);
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let used = 0;
  let output = '';
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

/**
 * Normalize one accepted session title and enforce its UTF-8 byte budget.
 * @param input - untrusted title text.
 * @param maxBytes - positive maximum encoded size.
 * @returns a terminal-safe one-line title, possibly empty after sanitization.
 */
export function normalizeSessionTitle(input: string, maxBytes: number): string {
  return truncateTitleUtf8(cleanTitleText(input), maxBytes).trimEnd();
}

/**
 * Derive the deterministic first-prompt fallback.
 * @param input - text from the first eligible human message.
 * @param maxWords - positive whitespace-delimited word cap.
 * @param maxBytes - positive UTF-8 byte cap.
 * @returns the normalized leading words within both limits.
 */
export function fallbackSessionTitle(input: string, maxWords: number, maxBytes: number): string {
  assertPositiveInteger('maxWords', maxWords);
  assertPositiveInteger('maxBytes', maxBytes);
  const words = cleanTitleText(input).split(' ').filter(Boolean).slice(0, maxWords);
  return truncateTitleUtf8(words.join(' '), maxBytes).trimEnd();
}

/**
 * Take the title from model output: the first non-empty line, without asterisk
 * emphasis that wraps that whole line. Models that disregard the one-line
 * instruction put the title first and commentary after it.
 */
export function titleFromModelOutput(text: string): string {
  const line = text.split(/\r?\n/u).map((item) => item.trim()).find((item) => item.length > 0) ?? '';
  const match = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u.exec(line);
  const marker = match?.groups?.['marker'];
  const inner = match?.groups?.['inner'];
  return marker === undefined || inner === undefined || inner.includes(marker) ? line : inner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMessageSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readModelIdentity(value: unknown): SessionTitleModelIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.provider !== 'string' || value.provider.length === 0
    || typeof value.model !== 'string' || value.model.length === 0) return undefined;
  return { provider: value.provider, model: value.model };
}

function readTitleSource(value: unknown): SessionTitleSource | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.kind) {
    case 'fallback':
      return { kind: 'fallback' };
    case 'user':
      return { kind: 'user' };
    case 'provider': {
      if (typeof value.provider !== 'string' || value.provider.length === 0) return undefined;
      const model = readModelIdentity(value.model);
      return {
        kind: 'provider',
        provider: value.provider,
        ...(model === undefined ? {} : { model }),
      };
    }
    default:
      return undefined;
  }
}

/**
 * Extract one eligible human text message from a session event.
 *
 * Only human `message/user` / `user/message` events with visible text qualify.
 * Goal rounds, external deliveries, subagent notices and image-only messages do
 * not. Legacy `user/message` events with an explicit non-human `source.kind`
 * are also ignored.
 */
export function sessionTitleMessage(event: SessionEvent): SessionTitleMessage | undefined {
  if (event.type !== 'message/user' && event.type !== 'user/message') return undefined;
  const data = event.data;
  let text = '';
  if (typeof data === 'string') {
    text = data;
  } else if (isRecord(data)) {
    const source = data.source;
    if (isRecord(source) && typeof source.kind === 'string' && source.kind !== 'user') return undefined;
    if (typeof data.text === 'string') {
      text = data.text;
    } else if (typeof data.content === 'string') {
      text = data.content;
    } else if (Array.isArray(data.content)) {
      text = data.content
        .filter((part): part is { type: 'text'; text: string } =>
          isRecord(part) && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    }
  }
  if (normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER).length === 0) return undefined;
  return { seq: event.seq, text };
}

/** Collect every eligible human text message in log order. */
export function collectSessionTitleMessages(events: readonly SessionEvent[]): SessionTitleMessage[] {
  const messages: SessionTitleMessage[] = [];
  for (const event of events) {
    const message = sessionTitleMessage(event);
    if (message !== undefined) messages.push(message);
  }
  return messages;
}

/**
 * Whether a session has received a human message with any visible content.
 * Image-only messages count as activity even though they cannot seed a title.
 */
export function hasHumanMessage(events: readonly SessionEvent[]): boolean {
  return events.some((event) => {
    if (event.type !== 'message/user' && event.type !== 'user/message') return false;
    const data = event.data;
    if (typeof data === 'string') return data.trim().length > 0;
    if (!isRecord(data)) return false;
    const source = data.source;
    if (isRecord(source) && typeof source.kind === 'string' && source.kind !== 'user') return false;
    if (typeof data.text === 'string' && data.text.trim().length > 0) return true;
    if (typeof data.content === 'string') return data.content.trim().length > 0;
    return Array.isArray(data.content) && data.content.length > 0;
  });
}

/**
 * Last activity timestamp for list ordering. Background title updates and pin
 * changes are UI state, not conversation activity, so neither may make an
 * older conversation jump to the top of the sidebar.
 */
export function lastActivityTime(events: readonly SessionEvent[], fallback: number): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.type !== SESSION_TITLE_EVENT && event.type !== SESSION_PIN_EVENT) {
      return event.ts;
    }
  }
  return fallback;
}

/**
 * Fold the latest logged title without consulting mutable metadata.
 * @param events - live or persisted session log.
 * @returns the latest immutable title snapshot, or `undefined`.
 */
export function foldSessionTitle(events: readonly SessionEvent[]): SessionTitleSnapshot | undefined {
  const event = events.findLast((item) => item.type === SESSION_TITLE_EVENT);
  if (event === undefined || !isRecord(event.data)) return undefined;
  const title = event.data.title;
  const source = readTitleSource(event.data.source);
  const messageSeqs = event.data.messageSeqs;
  if (typeof title !== 'string' || title.length === 0 || source === undefined
    || !Array.isArray(messageSeqs) || !messageSeqs.every(isMessageSeq)) return undefined;
  return {
    title,
    messageSeqs: [...messageSeqs],
    source,
    eventSeq: event.seq,
    updatedAt: event.ts,
  };
}
