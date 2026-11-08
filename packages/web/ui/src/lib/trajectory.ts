import type {
  TrajectoryProjection,
  TrajectoryRecord,
  TraceEvent,
} from './wire.ts';
import { translator, type Locale } from './i18n.ts';

export function formatDate(value: unknown, withDate: boolean): string {
  if (value === undefined || value === null || value === '') return '—';
  const date = new Date(value as string | number);
  if (Number.isNaN(date.getTime())) return '—';
  return withDate
    ? date.toLocaleString()
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function relativeDate(value: unknown, locale: Locale = 'zh'): string {
  const t = translator(locale);
  const time = new Date(value as string | number).getTime();
  if (!Number.isFinite(time)) return t('Unknown time');
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return t('Just now');
  if (minutes < 60) return t('{minutes}m ago', { minutes });
  if (minutes < 1440) return t('{hours}h ago', { hours: Math.floor(minutes / 60) });
  if (minutes < 10080) return t('{days}d ago', { days: Math.floor(minutes / 1440) });
  return new Date(time).toLocaleDateString();
}

export function shortId(id: unknown): string {
  const value = String(id ?? '');
  return value.length > 20 ? `${value.slice(0, 16)}…` : value;
}

export function stringify(value: unknown): string {
  try {
    const result = JSON.stringify(value, null, 2);
    return result === undefined ? String(value) : result;
  } catch {
    return '[Unable to display value]';
  }
}

export interface TrajectorySpan {
  record: TrajectoryRecord;
  lane: 'input' | 'model' | 'tools';
  start: number;
  end: number;
}

export function trajectoryModel(projection: unknown, scale: 'sequence' | 'time'): {
  records: TrajectoryRecord[];
  spans: TrajectorySpan[];
} {
  const value = projection as TrajectoryProjection | null | undefined;
  const records = value?.version === 1 && Array.isArray(value.records)
    ? value.records.filter((record): record is TrajectoryRecord => typeof record?.id === 'string')
    : [];
  const byId = new Map(records.map((record) => [record.id, record]));
  const raw = value?.version === 1 && Array.isArray(value.timeline?.[scale])
    ? value.timeline[scale]!
    : [];
  const spans = raw.flatMap((span): TrajectorySpan[] => {
    const record = byId.get(span.recordId);
    if (record === undefined || !['input', 'model', 'tools'].includes(span.lane)
      || !Number.isFinite(span.start) || !Number.isFinite(span.end) || span.end < span.start) return [];
    return [{ record, lane: span.lane, start: span.start, end: span.end }];
  });
  return { records, spans };
}

type Metadata = Record<string, string | number | boolean>;

export function eventMetadata(event: unknown): Metadata {
  const metadata: Metadata = {};
  const record = typeof event === 'object' && event !== null ? event as Record<string, unknown> : {};
  const data = typeof record.data === 'object' && record.data !== null
    ? record.data as Record<string, unknown>
    : record;
  const type = typeof record.type === 'string' ? record.type : 'event';
  const eventType = type.startsWith('trace/') ? type.slice(6) : type;
  const add = (label: string, value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') metadata[label] = value;
  };
  add('Type', type);
  add('Sequence', record.seq);
  add('Timestamp', record.ts);
  if (eventType === 'audit.tool') {
    add('Tool name', data.tool);
    add('Call ID', data.callId);
    add('Decision', data.decision);
    add('Success', data.ok);
    add('Duration (ms)', data.durationMs);
    add('Step', data.step);
  } else if (eventType === 'tool.call' || eventType === 'tool/call') {
    const call = typeof data.call === 'object' && data.call !== null ? data.call as Record<string, unknown> : data;
    add('Tool name', call.name);
    add('Call ID', call.id);
  } else if (eventType === 'tool.result' || eventType === 'tool/result' || eventType === 'message/tool-result') {
    const result = typeof data.result === 'object' && data.result !== null ? data.result as Record<string, unknown> : data;
    add('Tool name', result.name);
    add('Call ID', result.callId);
    add('Success', result.ok);
    add('Duration (ms)', result.durationMs);
    add('Truncated', result.truncated);
  } else if (eventType === 'permission.decided' || eventType === 'permission/decided') {
    add('Call ID', data.callId);
    add('Decision', data.decision);
  } else if (eventType === 'turn.start' || eventType === 'turn/start') {
    add('Step', data.step);
  } else if (eventType === 'turn.end' || eventType === 'turn/end') {
    add('Reason', data.reason);
  } else if (eventType === 'context.compacted' || eventType === 'context/compacted') {
    add('Before tokens', data.beforeTokens);
    add('After tokens', data.afterTokens);
  } else if (eventType === 'error') {
    const error = typeof data.error === 'object' && data.error !== null ? data.error as Record<string, unknown> : {};
    add('Code', error.code);
    add('Retryable', error.retryable);
  }
  return metadata;
}

const SAFE_TRACE_TYPES = [
  'trace/turn.start', 'trace/turn.end', 'trace/tool.call', 'trace/permission.decided',
  'trace/tool.result', 'trace/context.compacted', 'trace/error', 'audit.tool',
] as const;

export function safeEventMetadata(event: unknown): Metadata {
  const record = typeof event === 'object' && event !== null ? event as Record<string, unknown> : {};
  const type = typeof record.type === 'string' && (SAFE_TRACE_TYPES as readonly string[]).includes(record.type)
    ? record.type
    : 'trace/unknown';
  const raw = eventMetadata({ ...record, type });
  const metadata: Metadata = { Type: type };
  const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const timestamp = (value: unknown): value is number => integer(value) && value <= 8640000000000000;
  if (integer(raw.Sequence)) metadata.Sequence = raw.Sequence as number;
  if (type === 'audit.tool' && typeof raw.Timestamp === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw.Timestamp)) {
    const parsed = Date.parse(raw.Timestamp);
    if (timestamp(parsed) && new Date(parsed).toISOString() === (raw.Timestamp.length === 20 ? `${raw.Timestamp.slice(0, -1)}.000Z` : raw.Timestamp)) {
      metadata.Timestamp = parsed;
    }
  } else if (type !== 'audit.tool' && timestamp(raw.Timestamp)) {
    metadata.Timestamp = raw.Timestamp as number;
  }
  if (['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'web_fetch'].includes(String(raw['Tool name']))) {
    metadata['Tool name'] = raw['Tool name'] as string;
  }
  if (['allow', 'ask', 'deny'].includes(String(raw.Decision))) metadata.Decision = raw.Decision as string;
  if (['end_turn', 'tool_use', 'max_tokens', 'max_steps', 'interrupted', 'error'].includes(String(raw.Reason))) {
    metadata.Reason = raw.Reason as string;
  }
  for (const label of ['Step', 'Before tokens', 'After tokens']) {
    if (integer(raw[label])) metadata[label] = raw[label] as number;
  }
  if (nonnegative(raw['Duration (ms)'])) metadata['Duration (ms)'] = raw['Duration (ms)'] as number;
  for (const label of ['Success', 'Truncated']) {
    if (typeof raw[label] === 'boolean') metadata[label] = raw[label] as boolean;
  }
  return metadata;
}

export interface LedgerEvent {
  id: string;
  metadata: Metadata;
}

export function ledgerEvents(events: readonly unknown[], audit: readonly unknown[]): LedgerEvent[] {
  const traces = events.flatMap((event, index): LedgerEvent[] => (
    typeof event === 'object' && event !== null && typeof (event as TraceEvent).type === 'string'
      && (event as TraceEvent).type!.startsWith('trace/')
      ? [{ id: `trace:${index}`, metadata: safeEventMetadata(event) }]
      : []
  ));
  return traces.concat(audit.map((item, index) => ({
    id: `audit:${index}`,
    metadata: safeEventMetadata({
      type: 'audit.tool',
      ts: typeof item === 'object' && item !== null ? (item as { ts?: unknown }).ts : undefined,
      data: item,
    }),
  })));
}

export type EventCategory = 'audit' | 'errors' | 'tools' | 'lifecycle';

export function eventCategory(metadata: Metadata): EventCategory {
  const type = metadata.Type;
  if (type === 'audit.tool') return 'audit';
  if (type === 'trace/error') return 'errors';
  if (type === 'trace/tool.call' || type === 'trace/tool.result' || type === 'trace/permission.decided') return 'tools';
  return 'lifecycle';
}

export function eventSummary(metadata: Metadata): string {
  const parts: string[] = [];
  if (metadata['Tool name'] !== undefined) parts.push(String(metadata['Tool name']));
  if (metadata.Decision !== undefined) parts.push(String(metadata.Decision));
  if (metadata.Success !== undefined) parts.push(metadata.Success ? 'succeeded' : 'failed');
  if (metadata.Reason !== undefined) parts.push(String(metadata.Reason));
  if (metadata.Step !== undefined) parts.push(`step ${metadata.Step}`);
  if (metadata['Duration (ms)'] !== undefined) parts.push(`${metadata['Duration (ms)']} ms`);
  if (metadata['Before tokens'] !== undefined && metadata['After tokens'] !== undefined) {
    parts.push(`${metadata['Before tokens']} → ${metadata['After tokens']} tokens`);
  }
  return parts.join(' · ');
}

const RECORD_LABELS: Record<string, string> = {
  id: 'Record ID',
  kind: 'Kind',
  seq: 'Sequence',
  turnId: 'Turn ID',
  stepId: 'Step ID',
  step: 'Step',
  timestamp: 'Timestamp',
  assistantSeq: 'Assistant sequence',
  assistantRecordedAt: 'Assistant recorded at',
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  name: 'Tool name',
  callSeq: 'Call sequence',
  callRecordedAt: 'Call recorded at',
  resultSeq: 'Result sequence',
  resultRecordedAt: 'Result recorded at',
  durationMs: 'Duration (ms)',
  ok: 'Success',
  truncated: 'Truncated',
  decision: 'Decision',
};

export function recordMetadata(record: TrajectoryRecord): Metadata {
  const metadata: Metadata = {};
  for (const [key, label] of Object.entries(RECORD_LABELS)) {
    const value = (record as unknown as Record<string, unknown>)[key];
    if (value !== undefined && value !== null && ['string', 'number', 'boolean'].includes(typeof value)) {
      metadata[label] = value as string | number | boolean;
    }
  }
  return metadata;
}

export function recordLabel(record: TrajectoryRecord): string {
  if (record.kind === 'input') return 'User input';
  if (record.kind === 'model') return 'Model response';
  if (record.kind === 'tool') return record.name ?? 'Tool';
  return 'Record';
}
