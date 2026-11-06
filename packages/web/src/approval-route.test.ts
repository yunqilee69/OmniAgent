import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeModel, Session, SessionStore, textResponse, toolCallResponse } from '@omniagent/core';
import { createInitialDshPermissionEvent } from '../../core/src/permissions/dsh-permissions';
import { ApprovalBroker } from './approval';
import { startWebHost } from './server';
import type { WebHost } from './server';
import { WorkspaceRegistry } from './workspaces';

const hosts: WebHost[] = [];
const roots: string[] = [];
const originalContent = 'visible contents';
const newContent = 'private write contents';
const call = { id: 'call', name: 'write_file', args: { file_path: 'visible.txt', content: newContent,
  sandbox_permissions: 'workspace-write', justification: 'Write the requested file',
} };

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-web-approval-route-'));
  roots.push(root);
  const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
  const firstPath = join(root, 'first');
  const secondPath = join(root, 'second');
  await mkdir(firstPath);
  await mkdir(secondPath);
  await writeFile(join(firstPath, 'visible.txt'), originalContent);
  const first = await workspaces.add(firstPath);
  const second = await workspaces.add(secondPath);
  const store = new SessionStore(join(root, 'sessions'));
  for (const workspace of [first, second]) {
    const handle = await store.create({ id: 'same', workspace: workspace.path, cwd: workspace.path });
    await handle.append(createInitialDshPermissionEvent('read-only'));
  }
  const broker = new ApprovalBroker({ timeoutMs: 10_000 });
  const host = await startWebHost({
    workspaces, store, approvalBroker: broker,
    createSession: (workspace, handle, permissions) => new Session({
      cwd: workspace.path, session: handle, dshPermissions: permissions,
      approve: broker.handler(workspace.path, handle.id),
      model: new FakeModel([
        toolCallResponse([call]),
        textResponse('done'),
      ], { onExhausted: textResponse('done') }),
    }),
  });
  hosts.push(host);
  const url = (workspace: string) => `${host.address()}/api/workspaces/${workspace}/sessions/same`;
  return { first, second, store, url };
}

function reader(response: Response) {
  const source = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next(): Promise<Record<string, unknown>> {
      while (true) {
        const index = buffer.indexOf('\n\n');
        if (index !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (frame.startsWith('data: ')) return JSON.parse(frame.slice(6)) as Record<string, unknown>;
          continue;
        }
        const chunk = await source.read();
        if (chunk.done) throw new Error('Stream ended before the expected event');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: () => source.cancel(),
  };
}

async function until(stream: ReturnType<typeof reader>, type: string) {
  const events: Record<string, unknown>[] = [];
  while (true) {
    const event = await stream.next();
    events.push(event);
    if (event.type === type) return { event, events };
    if (event.type === 'turn.end') throw new Error(`Turn ended before ${type}: ${JSON.stringify(events)}`);
  }
}

describe('workspace-scoped approval API', () => {
  it('approves only the requested call once and rejects cross-workspace or duplicate responses', async () => {
    const { first, second, store, url } = await setup();
    const response = await fetch(`${url(first.id)}/messages`, post({ text: 'write the file' }));
    expect(response.status).toBe(200);
    const stream = reader(response);
    try {
      const { event } = await until(stream, 'permission.requested');
      const requestId = event.requestId;
      expect(typeof requestId).toBe('string');
      expect(event.call).toEqual({ id: call.id, name: call.name, arguments: call.args });
      expect(await readFile(join(first.path, 'visible.txt'), 'utf8')).toBe(originalContent);
      expect((await fetch(`${url(second.id)}/approvals`, post({ requestId, decision: 'allow' }))).status).toBe(409);
      expect((await fetch(`${url(first.id)}/approvals`, post({ requestId, decision: 'always' }))).status).toBe(400);
      expect((await fetch(`${url(first.id)}/approvals`, post({ requestId, decision: 'allow' }))).status).toBe(200);
      expect((await fetch(`${url(first.id)}/approvals`, post({ requestId, decision: 'allow' }))).status).toBe(409);
      const rest = (await until(stream, 'turn.end')).events;
      expect(rest.find((item) => item.type === 'permission.decided')).toMatchObject({ decision: 'allow' });
      expect(rest.find((item) => item.type === 'tool.result')).toMatchObject({ result: { ok: true, content: expect.stringContaining('visible.txt') } });
      expect(await readFile(join(first.path, 'visible.txt'), 'utf8')).toBe(newContent);
      const log = await store.open(first.path, 'same');
      const trace = JSON.stringify(log.events.filter((item) => item.type.startsWith('trace/')));
      expect(trace).not.toContain('visible.txt');
      expect(trace).not.toContain(originalContent);
      expect(trace).not.toContain(newContent);
      expect(trace).not.toContain(requestId);
    } finally { await stream.cancel(); }
  });

  it('rejects a request without running its tool', async () => {
    const { first, url } = await setup();
    const stream = reader(await fetch(`${url(first.id)}/messages`, post({ text: 'write the file' })));
    try {
      const { event } = await until(stream, 'permission.requested');
      expect((await fetch(`${url(first.id)}/approvals`, post({ requestId: event.requestId, decision: 'deny' }))).status).toBe(200);
      const rest = (await until(stream, 'turn.end')).events;
      expect(rest.find((item) => item.type === 'permission.decided')).toMatchObject({ decision: 'deny' });
      expect(rest.find((item) => item.type === 'tool.result')).toMatchObject({ result: { ok: false } });
      expect(JSON.stringify(rest)).not.toContain(originalContent);
      expect(await readFile(join(first.path, 'visible.txt'), 'utf8')).toBe(originalContent);
    } finally { await stream.cancel(); }
  });

  it('invalidates a pending request immediately on interruption', async () => {
    const { first, url } = await setup();
    const stream = reader(await fetch(`${url(first.id)}/messages`, post({ text: 'write the file' })));
    try {
      const { event } = await until(stream, 'permission.requested');
      expect((await fetch(`${url(first.id)}/interrupt`, post({}))).status).toBe(200);
      expect((await fetch(`${url(first.id)}/approvals`, post({ requestId: event.requestId, decision: 'allow' }))).status).toBe(409);
      const rest = (await until(stream, 'turn.end')).events;
      expect(rest.at(-1)).toMatchObject({ reason: 'interrupted' });
      expect(JSON.stringify(rest)).not.toContain(originalContent);
      expect(await readFile(join(first.path, 'visible.txt'), 'utf8')).toBe(originalContent);
    } finally { await stream.cancel(); }
  });

  it('invalidates a pending request when the stream disconnects', async () => {
    const { first, store, url } = await setup();
    const stream = reader(await fetch(`${url(first.id)}/messages`, post({ text: 'write the file' })));
    const { event } = await until(stream, 'permission.requested');
    await stream.cancel();
    await expect.poll(async () => (await store.open(first.path, 'same')).events.some((item) => item.type === 'trace/turn.end'), { timeout: 2000 }).toBe(true);
    expect((await fetch(`${url(first.id)}/approvals`, post({ requestId: event.requestId, decision: 'allow' }))).status).toBe(409);
    expect((await store.open(first.path, 'same')).events.some((item) => item.type === 'message/tool-result')).toBe(false);
    expect(await readFile(join(first.path, 'visible.txt'), 'utf8')).toBe(originalContent);
  });
});
