import type { AgentError } from '../protocol/events';

/**
 * Provider failures that are safe to describe to a user.
 *
 * pi-ai reports HTTP failures as `"<status>: <body>"`. The body is a structured
 * provider error envelope, so its status, code, message and per-backend detail
 * can be surfaced without echoing arbitrary response text. Unstructured bodies
 * stay out of the summary: they can contain credentials or prompt content.
 */

export interface ProviderErrorFields {
  status?: number;
  code?: string;
  message?: string;
  retryable?: boolean;
}

const ERROR_TEXT_LIMIT = 500;
const PROVIDER_MESSAGE_LIMIT = 300;
const DETAIL_MESSAGE_LIMIT = 240;
const DETAIL_ENTRY_LIMIT = 3;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const PLAIN_STATUS = /^(\d{3}):\s*([\s\S]*)$/;
const LABELED_STATUS = /^[^()\n]{0,40}?\((\d{3})\):\s*([\s\S]*)$/;

export class ProviderRequestError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;

  constructor(message: string, fields: ProviderErrorFields = {}) {
    super(message);
    this.name = 'ProviderRequestError';
    if (fields.status !== undefined) this.status = fields.status;
    if (fields.code !== undefined) this.code = fields.code;
    this.retryable = fields.retryable ?? retryableStatus(fields.status);
  }
}

function retryableStatus(status: number | undefined): boolean {
  return status !== undefined
    && (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function statusCode(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : undefined;
}

/**
 * Keep a provider message readable while removing the common credential shapes
 * that providers echo back (the OpenAI invalid-key message is the usual case).
 */
function cleanText(value: string, limit: number): string {
  const collapsed = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const redacted = collapsed
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/gi, '$1-***')
    .replace(/\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)[^\s,;]+/gi, '$1$2***')
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, '***');
  return redacted.length > limit ? `${redacted.slice(0, limit - 1)}…` : redacted;
}

function parseBody(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return undefined;
  // pi-ai caps bodies and may append a truncation marker; the JSON prefix is
  // still usable for the fields we read.
  const end = trimmed.lastIndexOf('}');
  if (end < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(0, end + 1));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function errorCode(body: Record<string, unknown> | undefined): string | undefined {
  if (body === undefined) return undefined;
  const candidates = [body.code, (isRecord(body.error) ? body.error.code : undefined), body.type];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && CODE_PATTERN.test(candidate)) return candidate;
  }
  return undefined;
}

function errorMessage(body: Record<string, unknown> | undefined): string | undefined {
  if (body === undefined) return undefined;
  return text(body.message) ?? (isRecord(body.error) ? text(body.error.message) : undefined);
}

function errorDetail(body: Record<string, unknown> | undefined): string | undefined {
  if (body === undefined || !Array.isArray(body.detail)) return undefined;
  const parts: string[] = [];
  for (const entry of body.detail.slice(0, DETAIL_ENTRY_LIMIT)) {
    if (!isRecord(entry)) continue;
    const model = text(entry.model);
    const status = text(entry.status);
    const reason = text(entry.reason);
    const label = [model, status].filter((part): part is string => part !== undefined).join(': ');
    if (label !== '' || reason !== undefined) {
      parts.push(reason === undefined ? label : `${label} (${reason})`);
    }
  }
  return parts.length === 0 ? undefined : cleanText(parts.join('; '), DETAIL_MESSAGE_LIMIT);
}

/**
 * Convert a provider's `errorMessage` into a display-safe failure.
 *
 * Only a structured JSON envelope contributes a human message or detail. The
 * HTTP status and error code are always safe identifiers, so they survive even
 * when the body is absent or unparseable.
 */
export function providerRequestError(message: string | undefined, fallback: string): ProviderRequestError {
  const raw = typeof message === 'string' ? message.trim() : '';
  if (raw === '') return new ProviderRequestError(fallback);

  const matched = PLAIN_STATUS.exec(raw) ?? LABELED_STATUS.exec(raw);
  const status = matched === null ? undefined : statusCode(matched[1]!);
  const bodyText = matched === null ? (raw.startsWith('{') ? raw : undefined) : matched[2];
  const body = parseBody(bodyText);
  const code = errorCode(body);
  const detail = errorDetail(body);
  // A structured envelope's message is written for clients. Without a code or
  // type the body is opaque, so it never becomes part of the summary.
  const providerMessage = code === undefined ? undefined : errorMessage(body);

  const headline = status === undefined ? fallback : `HTTP ${status}`;
  let summary = code === undefined ? headline : `${headline} · ${code}`;
  if (providerMessage !== undefined) summary += `: ${cleanText(providerMessage, PROVIDER_MESSAGE_LIMIT)}`;
  if (detail !== undefined) summary += ` (${detail})`;

  return new ProviderRequestError(cleanText(summary, ERROR_TEXT_LIMIT), { status, code });
}

/** Map any thrown value to the public error contract. */
export function agentErrorFromUnknown(error: unknown, fallback = 'Unknown error'): AgentError {
  if (error instanceof ProviderRequestError) {
    return {
      message: error.message,
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.status === undefined ? {} : { status: error.status }),
      retryable: error.retryable,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message: message === '' ? fallback : message };
}
