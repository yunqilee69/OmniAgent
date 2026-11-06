import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeModel, Session, SessionStore, textResponse, toolCallResponse } from '@omniagent/core';
import { projectTrajectory } from './trajectory';
import type { TrajectoryEvent, TrajectoryToolRecord } from './trajectory';

const event = (seq: number, type: string, data: unknown, ts?: number | null): TrajectoryEvent => ({
  seq, type, data, ...(ts === undefined ? {} : { ts }),
});

function tools(events: readonly TrajectoryEvent[]): TrajectoryToolRecord[] {
  return projectTrajectory(events).records.filter((record): record is TrajectoryToolRecord => record.kind === 'tool');
}

describe('projectTrajectory', () => {
  it('projects ordered input, model steps, tools, and both timeline domains', () => {
    const events = [
      event(0, 'message/user', { text: 'private input' }, 0),
      event(1, 'trace/turn.start', { step: 0 }, 1),
      event(2, 'message/assistant', { role: 'assistant', content: [], usage: { inputTokens: 7, outputTokens: 0 },
        toolCalls: [{ id: 'c', name: 'read_file', arguments: { file_path: 'private' } }] }, 10),
      event(3, 'trace/tool.call', { id: 'c', name: 'read_file' }, 12),
      event(4, 'trace/permission.decided', { callId: 'c', decision: 'allow' }, 13),
      event(5, 'message/tool-result', { result: { callId: 'c', name: 'read_file', ok: true,
        content: 'private output', truncated: false, durationMs: 7 } }, 20),
      event(6, 'trace/tool.result', { callId: 'c', name: 'read_file', ok: true, truncated: false, durationMs: 7 }, 21),
      event(7, 'trace/turn.start', { step: 1 }, 22),
      event(8, 'message/assistant', { role: 'assistant', content: [], toolCalls: [] }, 23),
      event(9, 'trace/turn.end', { reason: 'end_turn' }, 24),
    ];

    expect(projectTrajectory(events)).toEqual({
      version: 1,
      turns: [{ id: 'turn:0', inputRecordId: 'input:0', startSeq: 0, endSeq: 9, endReason: 'end_turn' }],
      records: [
        { id: 'input:0', kind: 'input', seq: 0, turnId: 'turn:0', stepId: null, step: null, timestamp: 0 },
        { id: 'model:1', kind: 'model', seq: 1, turnId: 'turn:0', stepId: 'step:1', step: 0, timestamp: 1,
          assistantSeq: 2, assistantRecordedAt: 10, inputTokens: 7, outputTokens: 0 },
        { id: 'tool:2:0', kind: 'tool', seq: 2, turnId: 'turn:0', stepId: 'step:1', step: 0, timestamp: 10,
          name: 'read_file', callSeq: 3, callRecordedAt: 12, resultSeq: 5, resultRecordedAt: 20,
          durationMs: 7, ok: true, truncated: false, decision: 'allow' },
        { id: 'model:7', kind: 'model', seq: 7, turnId: 'turn:0', stepId: 'step:7', step: 1, timestamp: 22,
          assistantSeq: 8, assistantRecordedAt: 23, inputTokens: null, outputTokens: null },
      ],
      timeline: {
        sequence: [
          { recordId: 'input:0', lane: 'input', start: 0, end: 1 },
          { recordId: 'model:1', lane: 'model', start: 1, end: 2 },
          { recordId: 'tool:2:0', lane: 'tools', start: 2, end: 3 },
          { recordId: 'model:7', lane: 'model', start: 3, end: 4 },
        ],
        time: [
          { recordId: 'input:0', lane: 'input', start: 0, end: 0 },
          { recordId: 'model:1', lane: 'model', start: 1, end: 1 },
          { recordId: 'tool:2:0', lane: 'tools', start: 12, end: 20 },
          { recordId: 'model:7', lane: 'model', start: 22, end: 22 },
        ],
      },
    });
  });

  it('returns only allowlisted facts, never raw text, identifiers, names, or arbitrary event data', () => {
    const secret = 'PRIVATE_SECRET_/home/user';
    const events = [
      event(0, 'message/user', { text: secret, metadata: secret }, 0),
      event(1, 'trace/turn.start', { step: 0, text: secret }, 1),
      event(2, 'message/assistant', { role: 'assistant', content: [{ text: secret }],
        usage: { inputTokens: -1, outputTokens: 3 },
        toolCalls: [{ id: secret, name: secret, arguments: secret, raw: secret }] }, 2),
      event(3, 'trace/tool.call', { id: secret, name: secret, arguments: secret }, 3),
      event(4, 'trace/permission.decided', { callId: secret, decision: 'deny', source: secret, rule: secret }, 4),
      event(5, 'message/tool-result', { result: { callId: secret, name: secret, ok: false,
        content: secret, fullOutputRef: secret, durationMs: 8 } }, 5),
      event(6, 'trace/error', { message: secret }, 6),
      event(7, 'trace/turn.end', { reason: secret }, 7),
      event(8, 'other/private', { secret }, 8),
      event(9, 'user/message', { text: secret, source: { kind: 'model' } }, 9),
    ];
    const projection = projectTrajectory(events);

    expect(JSON.stringify(projection)).not.toContain(secret);
    expect(projection.turns).toHaveLength(1);
    expect(projection.turns[0]?.endReason).toBeNull();
    expect(projection.records.find((record) => record.kind === 'model')).toMatchObject({ inputTokens: null, outputTokens: 3 });
    expect(projection.records.find((record) => record.kind === 'tool')).toMatchObject({ name: null, decision: 'deny', ok: false });
    expect(projection.records.map((record) => record.kind)).toEqual(['input', 'model', 'tool']);
  });

  it('distinguishes agent steps from turns and isolates incomplete and orphaned turns', () => {
    const events = [
      event(0, 'message/user', { text: 'first' }, 0),
      event(1, 'trace/turn.start', { step: 0 }, 1),
      event(2, 'trace/tool.call', { id: 'reused', name: 'read_file' }, 2),
      event(3, 'trace/turn.start', { step: 1 }, 3),
      event(4, 'message/user', { text: 'second' }, 4),
      event(5, 'trace/turn.start', { step: 0 }, 5),
      event(6, 'message/tool-result', { result: { callId: 'reused', name: 'read_file', ok: true } }, 6),
      event(7, 'trace/turn.end', { reason: 'interrupted' }, 7),
      event(8, 'trace/tool.result', { callId: 'reused', name: 'read_file', ok: false }, 8),
      event(9, 'trace/turn.start', { step: 0 }, 9),
      event(10, 'trace/turn.end', { reason: 'end_turn' }, 10),
    ];
    const projection = projectTrajectory(events);

    expect(projection.turns).toEqual([
      { id: 'turn:0', inputRecordId: 'input:0', startSeq: 0, endSeq: null, endReason: null },
      { id: 'turn:4', inputRecordId: 'input:4', startSeq: 4, endSeq: 7, endReason: 'interrupted' },
      { id: 'turn:9', inputRecordId: null, startSeq: 9, endSeq: 10, endReason: 'end_turn' },
    ]);
    expect(projection.records.filter((record) => record.kind === 'model').map((record) => [record.turnId, record.step]))
      .toEqual([['turn:0', 0], ['turn:0', 1], ['turn:4', 0], ['turn:9', 0]]);
    expect(tools(events).map((record) => [record.turnId, record.callSeq, record.resultSeq]))
      .toEqual([['turn:0', 2, null], ['turn:4', null, 6], [null, null, 8]]);
  });

  it('treats a repeated step zero as a new incomplete turn even without a terminal event', () => {
    const projection = projectTrajectory([
      event(0, 'trace/turn.start', { step: 0 }, 0),
      event(1, 'trace/tool.call', { id: 'same', name: 'read_file' }, 1),
      event(2, 'trace/turn.start', { step: 0 }, 2),
      event(3, 'trace/tool.result', { callId: 'same', name: 'read_file', ok: true }, 3),
    ]);
    expect(projection.turns.map((turn) => turn.id)).toEqual(['turn:0', 'turn:2']);
    expect(projection.records.filter((record) => record.kind === 'tool')).toMatchObject([
      { turnId: 'turn:0', callSeq: 1, resultSeq: null },
      { turnId: 'turn:2', callSeq: null, resultSeq: 3 },
    ]);
  });

  it('matches reordered results by identity, merges duplicate traces, and preserves unequal durations', () => {
    const events = [
      event(0, 'message/user', {}, 0), event(1, 'trace/turn.start', { step: 0 }, 1),
      event(2, 'trace/tool.call', { id: 'a', name: 'read_file' }, 10),
      event(3, 'trace/tool.call', { id: 'b', name: 'write_file' }, 12),
      event(4, 'message/tool-result', { result: { callId: 'b', name: 'write_file', ok: false, durationMs: 2 } }, 15),
      event(5, 'trace/tool.result', { callId: 'b', name: 'write_file', ok: false, durationMs: 2 }, 16),
      event(6, 'message/tool-result', { result: { callId: 'a', name: 'read_file', ok: true, durationMs: 17 } }, 30),
      event(7, 'trace/tool.result', { callId: 'a', name: 'read_file', ok: true, durationMs: 17 }, 31),
      event(8, 'trace/tool.result', { callId: 'before', name: 'list_dir', ok: true, durationMs: 4 }, 32),
      event(9, 'trace/tool.call', { id: 'before', name: 'list_dir' }, 33),
      event(10, 'trace/tool.call', { id: 'unmatched', name: 'read_file' }, 34),
      event(11, 'trace/tool.result', { callId: 'other', name: 'write_file', ok: false }, 35),
    ];
    const projection = projectTrajectory(events);
    const records = projection.records.filter((record): record is TrajectoryToolRecord => record.kind === 'tool');

    expect(records.map((record) => [record.callSeq, record.resultSeq, record.durationMs, record.ok])).toEqual([
      [2, 6, 17, true], [3, 4, 2, false], [9, 8, 4, true], [10, null, null, null], [null, 11, null, false],
    ]);
    expect(projection.timeline.time.filter((span) => span.lane === 'tools').map(({ start, end }) => [start, end]))
      .toEqual([[10, 30], [12, 15], [32, 32], [34, 34], [35, 35]]);
  });

  it('does not guess associations when duplicate identities or conflicting duplicate metadata are ambiguous', () => {
    const events = [
      event(0, 'trace/turn.start', { step: 0 }, 0),
      event(1, 'trace/tool.call', { id: 'x', name: 'read_file' }, 1),
      event(2, 'trace/tool.call', { id: 'x', name: 'read_file' }, 2),
      event(3, 'trace/permission.decided', { callId: 'x', decision: 'deny' }, 3),
      event(4, 'message/tool-result', { result: { callId: 'x', name: 'read_file', ok: true, durationMs: 2 } }, 4),
      event(5, 'trace/tool.result', { callId: 'x', name: 'read_file', ok: false, durationMs: 5 }, 5),
    ];
    const records = tools(events);
    expect(records).toHaveLength(4);
    expect(records.map((record) => [record.callSeq, record.resultSeq, record.decision])).toEqual([
      [1, null, null], [2, null, null], [null, null, 'deny'], [null, 4, null],
    ]);
    expect(records[3]).toMatchObject({ ok: null, durationMs: null });
  });

  it('uses names to distinguish repeated IDs but never exports the ID', () => {
    const events = [
      event(0, 'trace/turn.start', { step: 0 }, 0),
      event(1, 'trace/tool.call', { id: 'private-id', name: 'read_file' }, 1),
      event(2, 'trace/tool.call', { id: 'private-id', name: 'write_file' }, 2),
      event(3, 'trace/tool.result', { callId: 'private-id', name: 'write_file', ok: true }, 3),
      event(4, 'trace/tool.result', { callId: 'private-id', name: 'read_file', ok: false }, 4),
    ];
    expect(tools(events).map((record) => [record.name, record.callSeq, record.resultSeq, record.ok]))
      .toEqual([['read_file', 1, 4, false], ['write_file', 2, 3, true]]);
    expect(JSON.stringify(projectTrajectory(events))).not.toContain('private-id');
  });

  it('handles missing, zero, invalid, and backwards timestamps without fabricating durations', () => {
    const events = [
      event(5, 'trace/tool.result', { callId: 'b', name: 'write_file', durationMs: 9 }, 5),
      event(0, 'message/user', {}, 0),
      event(2, 'message/assistant', { role: 'assistant', usage: { inputTokens: 0, outputTokens: 4 } }, 3),
      event(1, 'trace/turn.start', { step: 0 }),
      event(3, 'trace/tool.call', { id: 'a', name: 'read_file' }, 10),
      event(4, 'trace/tool.result', { callId: 'a', name: 'read_file', durationMs: 1 }, 0),
      event(6, 'trace/tool.call', { id: 'b', name: 'write_file' }, null),
      event(7, 'trace/tool.call', { id: 'c', name: 'list_dir' }, Number.NaN),
      event(8, 'trace/tool.result', { callId: 'c', name: 'list_dir', durationMs: -1 }),
    ];
    const projection = projectTrajectory(events);
    expect(projection.records.map((record) => record.seq)).toEqual([0, 1, 3, 5, 7]);
    expect(projection.records[1]).toMatchObject({ timestamp: null, assistantRecordedAt: 3, inputTokens: 0, outputTokens: 4 });
    expect(projection.timeline.time.map((span) => [span.recordId, span.start, span.end])).toEqual([
      ['input:0', 0, 0], ['model:1', 3, 3], ['tool:3:0', 10, 10], ['tool:5:0', 5, 5],
    ]);
    expect(tools(events).map((record) => record.durationMs)).toEqual([1, 9, null]);
  });

  it('preserves legacy and partial events without inventing a trace call or step', () => {
    const events = [
      event(0, 'user/message', { text: 'input' }, 0),
      event(1, 'assistant/message', { content: [], toolCalls: [{ id: 'c', name: 'read_file' }] }, 1),
      event(2, 'tool/result', { callId: 'c', name: 'read_file', ok: true, durationMs: 0 }, 2),
      event(3, 'assistant/message', { content: [], toolCalls: [] }, 3),
    ];
    const projection = projectTrajectory(events);
    expect(projection.records.map((record) => [record.kind, record.stepId, record.step])).toEqual([
      ['input', null, null], ['model', null, null], ['tool', null, null], ['model', null, null],
    ]);
    expect(tools(events)).toMatchObject([{ seq: 1, callSeq: null, resultSeq: 2, durationMs: 0 }]);
    expect(projection.timeline.time.find((span) => span.lane === 'tools')).toMatchObject({ start: 2, end: 2 });
  });

  it('deduplicates adjacent orphan message and trace results without attaching an orphan call', () => {
    const events = [
      event(0, 'trace/tool.call', { id: 'orphan', name: 'read_file' }, 0),
      event(1, 'message/tool-result', { result: { callId: 'orphan', name: 'read_file', ok: true, durationMs: 4 } }, 1),
      event(2, 'trace/tool.result', { callId: 'orphan', name: 'read_file', ok: true, durationMs: 4 }, 2),
    ];
    expect(tools(events).map((record) => [record.turnId, record.callSeq, record.resultSeq, record.ok])).toEqual([
      [null, 0, null, null], [null, null, 1, true],
    ]);
  });

  it('keeps same-message tool calls in their recorded array order beyond ten items', () => {
    const calls = Array.from({ length: 12 }, (_, index) => ({ id: `c${index}`, name: 'read_file' }));
    const projection = projectTrajectory([
      event(0, 'message/user', {}, 0),
      event(1, 'message/assistant', { role: 'assistant', toolCalls: calls }, 1),
    ]);
    expect(projection.records.filter((record) => record.kind === 'tool').map((record) => record.id))
      .toEqual(calls.map((_, index) => `tool:1:${index}`));
  });

  it('does not associate tools across multiple assistant messages without another step marker', () => {
    const events = [
      event(0, 'message/user', {}, 0), event(1, 'trace/turn.start', { step: 0 }, 1),
      event(2, 'message/assistant', { role: 'assistant', toolCalls: [{ id: 'same', name: 'read_file' }] }, 2),
      event(3, 'message/assistant', { role: 'assistant', toolCalls: [] }, 3),
      event(4, 'trace/tool.result', { callId: 'same', name: 'read_file', ok: true }, 4),
    ];
    expect(tools(events).map((record) => [record.seq, record.resultSeq])).toEqual([[2, null], [4, 4]]);
  });

  it('separates non-increasing step markers into different potentially incomplete turns', () => {
    const projection = projectTrajectory([
      event(0, 'message/user', {}, 0),
      event(1, 'trace/turn.start', { step: 1 }, 1),
      event(2, 'trace/turn.start', { step: 1 }, 2),
      event(3, 'trace/turn.start', { step: 2 }, 3),
      event(4, 'trace/turn.start', { step: 1 }, 4),
    ]);
    expect(projection.turns.map((turn) => turn.id)).toEqual(['turn:0', 'turn:2', 'turn:4']);
    expect(projection.records.filter((record) => record.kind === 'model').map((record) => [record.turnId, record.step]))
      .toEqual([['turn:0', 1], ['turn:2', 1], ['turn:2', 2], ['turn:4', 1]]);
  });

  it('deduplicates adjacent result copies with a missing ID only when their names agree', () => {
    const records = tools([
      event(0, 'message/user', {}, 0),
      event(1, 'message/tool-result', { result: { name: 'read_file', ok: true } }, 1),
      event(2, 'trace/tool.result', { name: 'read_file', ok: true }, 2),
      event(3, 'message/tool-result', { result: { name: 'read_file', ok: false } }, 3),
      event(4, 'trace/tool.result', { name: 'write_file', ok: false }, 4),
    ]);
    expect(records.map((record) => [record.name, record.resultSeq, record.ok])).toEqual([
      ['read_file', 1, true], ['read_file', 3, false], ['write_file', 4, false],
    ]);
  });

  it('rejects invalid or duplicate sequences and handles an empty snapshot', () => {
    expect(projectTrajectory([])).toEqual({ version: 1, turns: [], records: [], timeline: { sequence: [], time: [] } });
    expect(() => projectTrajectory([event(-1, 'message/user', {})])).toThrow();
    expect(() => projectTrajectory([event(0, 'message/user', {}), event(0, 'message/user', {})])).toThrow();
  });

  it('projects bash tool calls without exposing their command or output', () => {
    const records = tools([
      event(0, 'message/user', { text: 'private input' }, 0),
      event(1, 'trace/turn.start', { step: 0 }, 1),
      event(2, 'message/assistant', { role: 'assistant', content: [],
        toolCalls: [{ id: 's', name: 'bash', arguments: { command: 'PRIVATE COMMAND' } }] }, 2),
      event(3, 'trace/tool.call', { id: 's', name: 'bash' }, 3),
      event(4, 'message/tool-result', { result: { callId: 's', name: 'bash', ok: true, content: 'PRIVATE OUTPUT' } }, 4),
      event(5, 'trace/tool.result', { callId: 's', name: 'bash', ok: true, truncated: false, durationMs: 9 }, 5),
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ name: 'bash', ok: true, truncated: false, durationMs: 9 });
    expect(JSON.stringify(records)).not.toContain('PRIVATE');
  });

  it('projects a real Session trace with no audit duplicates or permission-rule leaks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-trajectory-'));
    try {
      const log = await new SessionStore(root).create({ id: 's', workspace: '/private', cwd: '/private' });
      const session = new Session({
        cwd: '/private', session: log,
        model: new FakeModel([
          toolCallResponse([{ id: 'private-id', name: 'read_file', args: { file_path: 'SECRET ARGUMENT' } }]),
          textResponse('SECRET ANSWER'),
        ]),
        rules: [{ raw: 'SECRET RULE', tool: 'read_file', source: 'session', decision: 'deny', anchor: '/private' }],
        approve: async () => 'deny',
      });
      for await (const _event of session.send('SECRET QUESTION')) { /* Drain the session. */ }
      const before = JSON.stringify(log.events);
      const projection = projectTrajectory(log.events);

      expect(projection.records.map((record) => record.kind)).toEqual(['input', 'model', 'tool', 'model']);
      expect(projection.turns).toHaveLength(1);
      expect(projection.records.find((record) => record.kind === 'tool')).toMatchObject({
        name: 'read_file', ok: false, decision: 'deny', durationMs: null,
      });
      expect(JSON.stringify(projection)).not.toMatch(/SECRET|private-id|\/private/);
      expect(JSON.stringify(log.events)).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
