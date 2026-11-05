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

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-web-export-'));
  const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
  const firstPath = join(root, 'first');
  const secondPath = join(root, 'second');
  await mkdir(firstPath);
  await mkdir(secondPath);
  const first = await workspaces.add(firstPath);
  const second = await workspaces.add(secondPath);
  const store = new SessionStore(join(root, 'sessions'));
  const left = await store.create({ id: 'same', workspace: first.path, cwd: first.path });
  const right = await store.create({ id: 'same', workspace: second.path, cwd: second.path });
  await left.append({ type: 'message/user', data: { text: 'FIRST TRANSCRIPT' } });
  await right.append({ type: 'message/user', data: { text: 'SECOND TRANSCRIPT' } });
  await left.append({ type: 'trace/permission.decided', data: { callId: 'c', decision: 'deny', rule: 'SECRET RULE' } });
  await left.append({ type: 'message/tool-result', data: { result: {
    callId: 'c', name: 'read_file', ok: false, content: 'SECRET RULE', truncated: false,
  } } });
  const host = await startWebHost({ workspaces, store, createSession: () => { throw new Error('unexpected'); } });
  hosts.push(host);
  return { base: host.address()!, first, second };
}

function url(base: string, workspace: string, session = 'same', format = 'json'): string {
  return `${base}/api/workspaces/${workspace}/sessions/${session}/export?format=${format}`;
}

describe('workspace-scoped session exports', () => {
  it('exports only the requested session and excludes permission data', async () => {
    const { base, first, second } = await setup();
    const response = await fetch(url(base, first.id));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="omniagent-session-[a-f0-9]{64}\.json"$/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text).format).toBe('omniagent-session-transcript');
    expect(text).toContain('FIRST TRANSCRIPT');
    expect(text).not.toContain('SECOND TRANSCRIPT');
    expect(text).not.toContain('SECRET RULE');
    const other = await (await fetch(url(base, second.id))).text();
    expect(other).toContain('SECOND TRANSCRIPT');
    expect(other).not.toContain('FIRST TRANSCRIPT');
  });

  it('returns markdown and rejects missing sessions and unsupported formats', async () => {
    const { base, first } = await setup();
    const response = await fetch(url(base, first.id, 'same', 'markdown'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(/\.md"$/);
    expect(await response.text()).toContain('FIRST TRANSCRIPT');
    expect((await fetch(url(base, 'missing'))).status).toBe(404);
    expect((await fetch(url(base, first.id, 'missing'))).status).toBe(404);
    expect((await fetch(url(base, first.id, 'same', 'zip'))).status).toBe(400);
    expect((await fetch(`${base}/api/workspaces/${first.id}/sessions/same/export`)).status).toBe(400);
  });
});
