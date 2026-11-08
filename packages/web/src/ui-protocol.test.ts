import { describe, expect, it } from 'vitest';
import {
  applyAgentEvent,
  createLiveState,
  createSSEParser,
  hydrateTranscript,
} from '../ui/src/lib/events.ts';
import {
  eventMetadata,
  safeEventMetadata,
  trajectoryModel,
} from '../ui/src/lib/trajectory.ts';
import { sessionKey } from '../ui/src/lib/store.ts';

describe('web client protocol', () => {
  it('clears a pending approval when a terminal error arrives', () => {
    const turn = createLiveState();
    turn.approval = { requestId: 'r1', call: { id: 'c1', name: 'bash', arguments: {} }, reason: '', pending: false, error: '' };
    applyAgentEvent(turn, { type: 'error', error: { message: 'Turn failed' } });
    expect(turn.approval).toBeUndefined();
    expect(turn.error).toBe('Turn failed');
  });

  it('keeps live turn indices aligned with loaded history', () => {
    const turn = createLiveState();
    turn.turns.push({ index: 2, startedAt: 1 });
    applyAgentEvent(turn, { type: 'turn.start' });
    applyAgentEvent(turn, { type: 'assistant.delta', text: 'reply' });
    expect(turn.turns.map((item) => item.index)).toEqual([2]);
    expect(turn.transcript[0]).toMatchObject({ kind: 'assistant', text: 'reply', turn: 2 });
    applyAgentEvent(turn, { type: 'turn.end', reason: 'end_turn' });
    applyAgentEvent(turn, { type: 'turn.start' });
    applyAgentEvent(turn, { type: 'assistant.delta', text: 'next' });
    expect(turn.turns.map((item) => item.index)).toEqual([2, 3]);
    expect(turn.transcript[1]).toMatchObject({ kind: 'assistant', text: 'next', turn: 3 });
  });

  it('correlates projected timeline spans by record ID and never synthesizes missing timing', () => {
    const projection = {
      version: 1,
      turns: [],
      records: [
        { id: 'input-1', kind: 'input', seq: 1, timestamp: null },
        { id: 'tool-1', kind: 'tool', seq: 2, name: 'read_file', durationMs: null, timestamp: 1000 },
      ],
      timeline: {
        sequence: [{ recordId: 'input-1', lane: 'input', start: 0, end: 1 }, { recordId: 'tool-1', lane: 'tools', start: 1, end: 2 }],
        time: [{ recordId: 'tool-1', lane: 'tools', start: 1000, end: 1000 }],
      },
    };
    const sequence = trajectoryModel(projection, 'sequence');
    expect(sequence.spans.map((span) => [span.record.id, span.lane, span.start, span.end])).toEqual([
      ['input-1', 'input', 0, 1], ['tool-1', 'tools', 1, 2],
    ]);
    const timed = trajectoryModel(projection, 'time');
    expect(timed.spans.map((span) => [span.record.id, span.start, span.end])).toEqual([['tool-1', 1000, 1000]]);
    expect(timed.records[0]!.timestamp).toBeNull();
    expect(trajectoryModel(null, 'time').spans).toHaveLength(0);
  });

  it('parses SSE events split across chunks and line endings', () => {
    const events: unknown[] = [];
    const parser = createSSEParser((event) => events.push(event));
    for (const chunk of [': keepalive\r', '\ndata: {"type":"assistant.', 'delta",\r\ndata: "text":"hello"}\r', '\n\r', '\ndata: {"type":"turn.end",', '"reason":"end_turn"}\n\n']) parser.push(chunk);
    parser.finish();
    expect(events).toEqual([{ type: 'assistant.delta', text: 'hello' }, { type: 'turn.end', reason: 'end_turn' }]);
  });

  it('dispatches a complete final frame and rejects malformed JSON', () => {
    const events: unknown[] = [];
    const parser = createSSEParser((event) => events.push(event));
    parser.push('data: {"type":"turn.end"}');
    parser.finish();
    expect(events).toEqual([{ type: 'turn.end' }]);
    expect(() => createSSEParser(() => {}).push('data: not-json\n\n')).toThrow();
  });

  it('hydrates projected messages and associates tool results by call id', () => {
    const { transcript } = hydrateTranscript([
      { role: 'user', content: [{ type: 'text', text: 'Read it' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Checking' }], toolCalls: [{ id: 'c1', name: 'read_file', arguments: { file_path: 'a.txt' } }] },
      { role: 'tool', results: [{ callId: 'c1', name: 'read_file', ok: true, content: 'contents', truncated: false }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done' }], toolCalls: [] },
    ], []);
    expect(transcript.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(transcript[2]).toMatchObject({ call: { id: 'c1' }, result: { content: 'contents', ok: true } });
  });

  it('hydrates stored message events when projected messages are absent', () => {
    const { transcript } = hydrateTranscript([], [
      { type: 'message/user', data: { text: 'Hello' } },
      { type: 'message/assistant', data: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] } },
    ]);
    expect(transcript.map((item) => [item.kind, item.kind === 'user' || item.kind === 'assistant' ? item.text : '']))
      .toEqual([['user', 'Hello'], ['assistant', 'Hi']]);
  });

  it('replaces streamed deltas with the authoritative assistant message and merges tools', () => {
    const turn = createLiveState();
    applyAgentEvent(turn, { type: 'assistant.delta', text: 'Hel' });
    applyAgentEvent(turn, { type: 'assistant.delta', text: 'lo' });
    applyAgentEvent(turn, { type: 'assistant.message', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }], toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }] } });
    applyAgentEvent(turn, { type: 'tool.call', call: { id: 'c1', name: 'read_file', arguments: { file_path: 'a' } } });
    applyAgentEvent(turn, { type: 'tool.result', result: { callId: 'c1', name: 'read_file', ok: true, content: 'ok', truncated: false } });
    applyAgentEvent(turn, { type: 'turn.start', step: 1 });
    applyAgentEvent(turn, { type: 'assistant.delta', text: 'Done' });
    applyAgentEvent(turn, { type: 'assistant.message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], toolCalls: [] } });
    expect(turn.transcript.map((item) => [item.kind, item.kind === 'assistant' ? item.text : undefined]))
      .toEqual([['assistant', 'Hello!'], ['tool', undefined], ['assistant', 'Done']]);
    expect(turn.transcript[1]).toMatchObject({ call: { id: 'c1', arguments: { file_path: 'a' } }, result: { ok: true } });
  });

  it('keeps event inspection limited to metadata, excluding payloads and audit digests', () => {
    const metadata = eventMetadata({
      type: 'tool.call', seq: 2, ts: 123,
      data: { call: { id: 'c1', name: 'read_file', arguments: { token: 'secret' }, raw: 'secret' } },
      argsDigest: 'secret', source: 'secret',
    });
    expect(metadata).toMatchObject({ Type: 'tool.call', Sequence: 2, 'Tool name': 'read_file', 'Call ID': 'c1' });
    expect(JSON.stringify(metadata)).not.toContain('secret');
    expect(JSON.stringify(eventMetadata({ type: 'error', error: { message: 'secret', code: 'FAILED' } }))).not.toContain('secret');
  });

  it('reads metadata from persisted trace event envelopes without exposing payloads', () => {
    expect(eventMetadata({ type: 'trace/turn.start', seq: 1, ts: 123, data: { step: 2 } }))
      .toMatchObject({ Type: 'trace/turn.start', Step: 2, Sequence: 1 });
    expect(eventMetadata({ type: 'trace/tool.call', data: { id: 'c1', name: 'read_file', arguments: { token: 'secret' } } }))
      .toMatchObject({ 'Tool name': 'read_file', 'Call ID': 'c1' });
    expect(eventMetadata({ type: 'trace/permission.decided', data: { callId: 'c1', decision: 'deny', source: 'secret' } }))
      .toMatchObject({ 'Call ID': 'c1', Decision: 'deny' });
    expect(eventMetadata({ type: 'trace/tool.result', data: { name: 'read_file', callId: 'c1', ok: false, content: 'secret', durationMs: 5 } }))
      .toMatchObject({ 'Tool name': 'read_file', 'Call ID': 'c1', Success: false, 'Duration (ms)': 5 });
    expect(eventMetadata({ type: 'trace/turn.end', data: { reason: 'interrupted' } })).toMatchObject({ Reason: 'interrupted' });
    expect(eventMetadata({ type: 'trace/tool.call', data: { call: { id: 'c2', name: 'other' } } })).toMatchObject({ 'Tool name': 'other', 'Call ID': 'c2' });
    expect(JSON.stringify(eventMetadata({ type: 'trace/tool.result', data: { result: { content: 'secret' } } }))).not.toContain('secret');
  });

  it('allowlists event inspector metadata and rejects arbitrary strings and invalid scalars', () => {
    const secret = 'SECRET_private_path_token';
    expect(safeEventMetadata({ type: 'trace/tool.result', seq: 4, ts: 1000, data: {
      name: 'read_file', callId: secret, content: secret, ok: false, truncated: true, durationMs: 8,
    } })).toMatchObject({ Type: 'trace/tool.result', Sequence: 4, Timestamp: 1000, 'Tool name': 'read_file', Success: false, Truncated: true, 'Duration (ms)': 8 });
    expect(safeEventMetadata({ type: 'trace/context.compacted', data: { beforeTokens: 100, afterTokens: 20 } }))
      .toMatchObject({ 'Before tokens': 100, 'After tokens': 20 });
    expect(safeEventMetadata({ type: 'audit.tool', ts: '2026-01-01T00:00:00Z', data: {
      tool: 'write_file', callId: secret, decision: 'deny', step: 0, ok: false, durationMs: 2, source: secret,
    } })).toMatchObject({ Type: 'audit.tool', Timestamp: Date.parse('2026-01-01T00:00:00Z'), 'Tool name': 'write_file', Decision: 'deny', Step: 0, Success: false, 'Duration (ms)': 2 });
    for (const event of [
      { type: 'trace/tool.call', seq: secret, ts: secret, data: { name: secret, id: secret, arguments: secret } },
      { type: 'trace/permission.decided', data: { callId: secret, decision: secret, source: secret } },
      { type: 'trace/turn.end', data: { reason: secret } },
      { type: 'trace/error', data: { error: { code: secret, message: secret }, message: secret } },
      { type: 'audit.tool', ts: secret, data: { tool: secret, callId: secret, decision: secret, durationMs: -1, step: 1.5, ok: secret } },
      { type: 'trace/' + secret, data: { message: secret } },
    ]) expect(JSON.stringify(safeEventMetadata(event))).not.toContain(secret);
    expect(safeEventMetadata({ type: 'trace/' + secret })).toMatchObject({ Type: 'trace/unknown' });
    expect(safeEventMetadata({ type: 'trace/turn.start', seq: -1, ts: Number.MAX_SAFE_INTEGER, data: { step: 1.5 } }))
      .toEqual({ Type: 'trace/turn.start' });
  });

  it('uses unambiguous workspace and session keys', () => {
    expect(sessionKey('a', 'same')).not.toBe(sessionKey('b', 'same'));
    expect(sessionKey('a/b', 'c')).not.toBe(sessionKey('a', 'b/c'));
  });

  it('tracks plan review prompts independently from tool approvals and clears them on turn end', () => {
    const turn = createLiveState();
    applyAgentEvent(turn, { type: 'plan.review.requested', requestId: 'plan-1', plan: '# Plan\n\nDo it.' });
    expect(turn.planReview).toEqual({
      requestId: 'plan-1', plan: '# Plan\n\nDo it.', pending: false, error: '', feedback: '',
    });
    expect(turn.approval).toBeUndefined();
    applyAgentEvent(turn, { type: 'permission.requested', requestId: 'tool-1', call: { id: 'c1', name: 'bash', arguments: {} }, reason: 'approval' });
    expect(turn.approval).toMatchObject({ requestId: 'tool-1' });
    expect(turn.planReview).toMatchObject({ requestId: 'plan-1' });
    applyAgentEvent(turn, { type: 'turn.end', reason: 'end_turn' });
    expect(turn.approval).toBeUndefined();
    expect(turn.planReview).toBeUndefined();
  });
});
