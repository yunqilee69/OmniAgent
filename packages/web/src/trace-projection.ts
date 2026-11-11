/**
 * Safe, metadata-only projection of persisted trace events.
 *
 * This intentionally does not preserve call identifiers: stored identifiers can
 * be reused or attacker-controlled, and the web UI does not need them.
 */

export type TraceToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'list_dir'
  | 'glob'
  | 'grep'
  | 'web_fetch'
  | 'skill'
  | 'bash'
  | 'todo_write'
  | 'exit_plan_mode'
  | 'get_goal'
  | 'create_goal'
  | 'update_goal'
  | 'subagent'
  | 'send_message'
  | 'list_agents'
  | 'wait_agent'
  | 'interrupt_agent';

const TRACE_TOOL_NAMES = new Set<string>([
  'read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'web_fetch',
  'skill', 'bash', 'todo_write',
  'exit_plan_mode', 'get_goal', 'create_goal', 'update_goal', 'subagent', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
]);
export type TraceStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'max_steps'
  | 'interrupted'
  | 'error';
export type TraceDecision = 'allow' | 'deny';

export type SafeTraceEventType =
  | 'trace/turn.start'
  | 'trace/turn.end'
  | 'trace/tool.call'
  | 'trace/permission.decided'
  | 'trace/tool.result'
  | 'trace/context.compacted'
  | 'trace/error';

export type SafeTraceData = Partial<{
  step: number;
  reason: TraceStopReason;
  name: TraceToolName;
  decision: TraceDecision;
  ok: boolean;
  truncated: boolean;
  durationMs: number;
  beforeTokens: number;
  afterTokens: number;
  /** Bounded, control-character-free error text; a placeholder for unstructured failures. */
  message: string;
  /** Provider error identifier, already validated by core. */
  code: string;
  /** HTTP status of a provider failure. */
  status: number;
  /** Whether retrying the same request may succeed. */
  retryable: boolean;
}>;

/** Error text is clipped so a single failure cannot bloat the session payload. */
const ERROR_TEXT_LIMIT = 500;

export interface SafeTraceEvent {
  seq?: number;
  ts?: number;
  type: SafeTraceEventType;
  data: SafeTraceData;
}

type RecordValue = Record<string, unknown>;

const TRACE_TYPES = new Set<SafeTraceEventType>([
  'trace/turn.start',
  'trace/turn.end',
  'trace/tool.call',
  'trace/permission.decided',
  'trace/tool.result',
  'trace/context.compacted',
  'trace/error',
]);

function record(value: unknown): RecordValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function safeIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function errorCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value) ? value : undefined;
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function toolName(value: unknown): TraceToolName | undefined {
  return typeof value === 'string' && TRACE_TOOL_NAMES.has(value) ? value as TraceToolName : undefined;
}

function stopReason(value: unknown): TraceStopReason | undefined {
  switch (value) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'max_steps':
    case 'interrupted':
    case 'error':
      return value;
    default:
      return undefined;
  }
}

function decision(value: unknown): TraceDecision | undefined {
  return value === 'allow' || value === 'deny' ? value : undefined;
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const stripped = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  if (stripped === '') return undefined;
  return stripped.length > ERROR_TEXT_LIMIT ? `${stripped.slice(0, ERROR_TEXT_LIMIT)}…` : stripped;
}

function nestedRecord(data: RecordValue | undefined, key: string): RecordValue | undefined {
  return record(data?.[key]) ?? data;
}

function setIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function projectData(type: SafeTraceEventType, value: unknown): SafeTraceData {
  const data = record(value);
  const projected: SafeTraceData = {};

  switch (type) {
    case 'trace/turn.start':
      setIfDefined(projected, 'step', safeIndex(data?.step));
      break;
    case 'trace/turn.end':
      setIfDefined(projected, 'reason', stopReason(data?.reason));
      break;
    case 'trace/tool.call':
      setIfDefined(projected, 'name', toolName(nestedRecord(data, 'call')?.name));
      break;
    case 'trace/permission.decided':
      setIfDefined(projected, 'decision', decision(data?.decision));
      break;
    case 'trace/tool.result': {
      const result = nestedRecord(data, 'result');
      setIfDefined(projected, 'name', toolName(result?.name));
      setIfDefined(projected, 'ok', safeBoolean(result?.ok));
      setIfDefined(projected, 'truncated', safeBoolean(result?.truncated));
      setIfDefined(projected, 'durationMs', safeNonnegativeNumber(result?.durationMs));
      break;
    }
    case 'trace/context.compacted':
      setIfDefined(projected, 'beforeTokens', safeIndex(data?.beforeTokens));
      setIfDefined(projected, 'afterTokens', safeIndex(data?.afterTokens));
      break;
    case 'trace/error':
      setIfDefined(projected, 'message', boundedText(data?.message));
      setIfDefined(projected, 'code', errorCode(data?.code));
      setIfDefined(projected, 'status', httpStatus(data?.status));
      setIfDefined(projected, 'retryable', safeBoolean(data?.retryable));
      break;
  }

  return projected;
}

/**
 * Projects stored events into the web-safe trace contract.
 *
 * Unknown event types are discarded. Known event types remain observable even
 * when their data is malformed, but their data then becomes an empty object.
 * Only nonnegative safe-integer `seq`/`ts` values are retained. The error message
 * is kept as bounded, control-character-free text: structured provider failures
 * carry a redacted summary, while other failures use a placeholder. No stored
 * call ID, argument, result, permission source/rule, or other arbitrary string
 * is copied.
 */
export function projectTraceEvents(events: readonly unknown[]): SafeTraceEvent[] {
  if (!Array.isArray(events)) return [];

  return events.flatMap((event): SafeTraceEvent[] => {
    const source = record(event);
    if (!source) return [];
    const type = source.type;
    if (typeof type !== 'string' || !TRACE_TYPES.has(type as SafeTraceEventType)) return [];

    const projected: SafeTraceEvent = {
      type: type as SafeTraceEventType,
      data: projectData(type as SafeTraceEventType, source.data),
    };
    const seq = safeIndex(source.seq);
    const ts = safeIndex(source.ts);
    if (seq !== undefined) projected.seq = seq;
    if (ts !== undefined) projected.ts = ts;
    return [projected];
  });
}
