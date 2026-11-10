import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '@omniagent/core';
import { startWebHost } from './server';
import type { WebHost } from './server';
import { WorkspaceRegistry } from './workspaces';

const hosts: WebHost[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.close())); });

describe('session trajectory projection', () => {
  it('projects ordered persisted activity without exposing arguments, output or private metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-web-trajectory-'));
    const workspacePath = join(root, 'project');
    await mkdir(workspacePath);
    const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
    const workspace = await workspaces.add(workspacePath);
    const store = new SessionStore(join(root, 'sessions'));
    const session = await store.create({ id: 'session', workspace: workspace.path, cwd: workspace.path });
    await session.append({ ts: 1000, type: 'message/user', data: { text: 'SECRET USER CONTENT' } });
    await session.append({ ts: 1100, type: 'trace/turn.start', data: { step: 0 } });
    await session.append({ ts: 1200, type: 'message/assistant', data: {
      role: 'assistant', content: [{ type: 'text', text: 'SECRET ASSISTANT CONTENT' }],
      requestDurationMs: 75, usage: { inputTokens: 12, outputTokens: 5, cachedInputTokens: 4 },
      toolCalls: [{ id: 'c', name: 'read_file', arguments: { file_path: 'SECRET ARGUMENT' } }],
    } });
    await session.append({ ts: 1300, type: 'trace/tool.call', data: { id: 'c', name: 'read_file', arguments: { file_path: 'SECRET ARGUMENT' } } });
    await session.append({ ts: 1400, type: 'trace/permission.decided', data: { callId: 'c', decision: 'allow', details: 'SECRET METADATA' } });
    await session.append({ ts: 1500, type: 'message/tool-result', data: { result: {
      callId: 'c', name: 'read_file', ok: true, content: 'SECRET OUTPUT', truncated: false, durationMs: 17,
    } } });
    await session.append({ ts: 1600, type: 'trace/tool.result', data: { callId: 'c', name: 'read_file', ok: true, truncated: false, durationMs: 17, content: 'SECRET OUTPUT' } });
    await session.append({ ts: 1700, type: 'trace/turn.end', data: { reason: 'end_turn' } });
    const host = await startWebHost({ workspaces, store, createSession: () => { throw new Error('unexpected'); } });
    hosts.push(host);

    const response = await fetch(`${host.address()}/api/workspaces/${workspace.id}/sessions/session`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      events: Array<{ type: string; data: unknown }>;
      trajectory: { version: number; records: Array<Record<string, unknown>>; timeline: { sequence: unknown[]; time: unknown[] } };
      metrics: unknown;
    };
    expect(body.metrics).toEqual({
      version: 1,
      runs: { started: 1, completed: 1, durationMs: 600, knownDurationCount: 1 },
      steps: { started: 1 },
      requests: { count: 1, durationMs: 75, knownDurationCount: 1 },
      usage: { inputTokens: 12, outputTokens: 5, inputKnownCount: 1, outputKnownCount: 1 },
      throughput: { outputTokens: 5, durationMs: 75, count: 1 },
      cache: { inputTokens: 12, cachedInputTokens: 4, count: 1 },
    });
    expect(JSON.stringify(body.metrics)).not.toContain('SECRET');
    expect(body.trajectory.version).toBe(1);
    expect(body.trajectory.records.map((record) => record.kind)).toEqual(['input', 'model', 'tool']);
    expect(body.trajectory.records[0]).toMatchObject({ kind: 'input', seq: 0, timestamp: 1000 });
    expect(body.trajectory.records[2]).toMatchObject({ kind: 'tool', name: 'read_file', durationMs: 17, ok: true, decision: 'allow' });
    expect(body.trajectory.timeline.sequence).toHaveLength(3);
    expect(body.trajectory.timeline.time).toHaveLength(3);
    expect(JSON.stringify(body.trajectory)).not.toContain('SECRET');
    expect(body.events.map((event) => event.type)).toContain('trace/permission.decided');
    expect(JSON.stringify(body.events)).not.toContain('SECRET');

    const eventsResponse = await fetch(`${host.address()}/api/workspaces/${workspace.id}/sessions/session/events`);
    expect(eventsResponse.status).toBe(200);
    const eventsBody = await eventsResponse.json() as { events: Array<{ type: string; data: unknown }> };
    expect(eventsBody.events.map((event) => event.type)).toContain('trace/permission.decided');
    expect(JSON.stringify(eventsBody.events)).not.toContain('SECRET');
  });
});
