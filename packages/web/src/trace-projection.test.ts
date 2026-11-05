import { describe, expect, it } from 'vitest';
import { projectTraceEvents } from './trace-projection';

describe('projectTraceEvents', () => {
  it('projects known trace fields and omits stored call IDs', () => {
    const events = projectTraceEvents([
      { seq: 1, ts: 100, type: 'trace/turn.start', data: { step: 0, prompt: 'PRIVATE PROMPT' } },
      {
        seq: 2,
        ts: 101,
        type: 'trace/tool.call',
        data: { id: 'private-call-id', name: 'read_file', arguments: { token: 'PRIVATE ARGUMENT' }, raw: 'PRIVATE RAW' },
      },
      {
        seq: 3,
        ts: 102,
        type: 'trace/permission.decided',
        data: { callId: 'private-call-id', decision: 'deny', source: 'PRIVATE RULE', rule: 'PRIVATE RULE' },
      },
      {
        seq: 4,
        ts: 103,
        type: 'trace/tool.result',
        data: {
          callId: 'private-call-id', name: 'read_file', ok: false, truncated: true, durationMs: 5,
          content: 'PRIVATE RESULT', fullOutputRef: 'PRIVATE REF',
        },
      },
      { seq: 5, ts: 104, type: 'trace/turn.end', data: { reason: 'interrupted', message: 'PRIVATE MESSAGE' } },
      { seq: 6, ts: 105, type: 'trace/context.compacted', data: { beforeTokens: 120, afterTokens: 30 } },
      { seq: 7, ts: 106, type: 'trace/error', data: { message: 'PRIVATE ERROR', code: 'PRIVATE CODE' } },
    ]);

    expect(events).toEqual([
      { seq: 1, ts: 100, type: 'trace/turn.start', data: { step: 0 } },
      { seq: 2, ts: 101, type: 'trace/tool.call', data: { name: 'read_file' } },
      { seq: 3, ts: 102, type: 'trace/permission.decided', data: { decision: 'deny' } },
      {
        seq: 4, ts: 103, type: 'trace/tool.result',
        data: { name: 'read_file', ok: false, truncated: true, durationMs: 5 },
      },
      { seq: 5, ts: 104, type: 'trace/turn.end', data: { reason: 'interrupted' } },
      { seq: 6, ts: 105, type: 'trace/context.compacted', data: { beforeTokens: 120, afterTokens: 30 } },
      { seq: 7, ts: 106, type: 'trace/error', data: {} },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|private-call-id/);
  });

  it('supports legacy nested call and result envelopes without retaining their payloads', () => {
    const events = projectTraceEvents([
      { seq: 8, ts: 200, type: 'trace/tool.call', data: { call: {
        id: 'legacy-id', name: 'write_file', arguments: { content: 'LEGACY SECRET' },
      } } },
      { seq: 9, ts: 201, type: 'trace/tool.result', data: { result: {
        callId: 'legacy-id', name: 'write_file', ok: true, content: 'LEGACY OUTPUT',
      } } },
    ]);

    expect(events).toEqual([
      { seq: 8, ts: 200, type: 'trace/tool.call', data: { name: 'write_file' } },
      { seq: 9, ts: 201, type: 'trace/tool.result', data: { name: 'write_file', ok: true } },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/LEGACY|legacy-id/);
  });

  it('drops unknown types and tool names and rejects invalid envelope and scalar values', () => {
    const events = projectTraceEvents([
      { seq: 1, ts: 1, type: 'trace/tool.call', data: { id: 'x', name: 'private_custom_tool' } },
      { seq: 2, ts: 2, type: 'trace/tool.result', data: { callId: 'x', name: 'private_custom_tool', ok: true } },
      { seq: 3, ts: 3, type: 'trace/future.event', data: { secret: 'PRIVATE' } },
      { seq: Number.NaN, ts: Number.POSITIVE_INFINITY, type: 'trace/turn.start', data: { step: -1 } },
      { seq: 4, ts: -1, type: 'trace/turn.end', data: { reason: 'PRIVATE REASON' } },
      { seq: 5, ts: 5, type: 'trace/context.compacted', data: { beforeTokens: 1.5, afterTokens: Number.NaN } },
      { seq: 6, ts: 6, type: 'trace/tool.result', data: { name: 'read_file', ok: 'yes', durationMs: -1 } },
      null,
      { seq: 7, ts: 7, type: 'message/user', data: { content: 'PRIVATE' } },
    ]);

    expect(events).toEqual([
      { seq: 1, ts: 1, type: 'trace/tool.call', data: {} },
      { seq: 2, ts: 2, type: 'trace/tool.result', data: { ok: true } },
      { type: 'trace/turn.start', data: {} },
      { seq: 4, type: 'trace/turn.end', data: {} },
      { seq: 5, ts: 5, type: 'trace/context.compacted', data: {} },
      { seq: 6, ts: 6, type: 'trace/tool.result', data: { name: 'read_file' } },
    ]);
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
  });

  it('does not preserve any stored identifier, including duplicated or hostile values', () => {
    const events = projectTraceEvents([
      { type: 'trace/tool.call', data: { id: 'same-id', name: 'list_dir' } },
      { type: 'trace/permission.decided', data: { callId: 'same-id', decision: 'allow' } },
      { type: 'trace/tool.result', data: { callId: 'same-id', name: 'list_dir', ok: true } },
      { type: 'trace/tool.call', data: { id: 'same-id', name: 'list_dir' } },
      { type: 'trace/tool.result', data: { callId: 'same-id', name: 'list_dir', ok: false } },
    ]);

    expect(events).toEqual([
      { type: 'trace/tool.call', data: { name: 'list_dir' } },
      { type: 'trace/permission.decided', data: { decision: 'allow' } },
      { type: 'trace/tool.result', data: { name: 'list_dir', ok: true } },
      { type: 'trace/tool.call', data: { name: 'list_dir' } },
      { type: 'trace/tool.result', data: { name: 'list_dir', ok: false } },
    ]);
    expect(JSON.stringify(events)).not.toContain('same-id');
  });

  it('does not preserve missing or oversized call IDs', () => {
    const events = projectTraceEvents([
      { type: 'trace/permission.decided', data: { callId: '', decision: 'allow' } },
      { type: 'trace/tool.call', data: { id: 'x'.repeat(257), name: 'list_dir' } },
      { type: 'trace/tool.result', data: { name: 'list_dir', ok: true } },
    ]);

    expect(events).toEqual([
      { type: 'trace/permission.decided', data: { decision: 'allow' } },
      { type: 'trace/tool.call', data: { name: 'list_dir' } },
      { type: 'trace/tool.result', data: { name: 'list_dir', ok: true } },
    ]);
  });

  it('keeps bash tool names while still omitting commands and output', () => {
    const events = projectTraceEvents([
      { type: 'trace/tool.call', data: { id: 'bash-call', name: 'bash', arguments: { command: 'PRIVATE COMMAND' } } },
      { type: 'trace/tool.result', data: { callId: 'bash-call', name: 'bash', ok: true, content: 'PRIVATE OUTPUT' } },
    ]);

    expect(events).toEqual([
      { type: 'trace/tool.call', data: { name: 'bash' } },
      { type: 'trace/tool.result', data: { name: 'bash', ok: true } },
    ]);
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
  });
});
