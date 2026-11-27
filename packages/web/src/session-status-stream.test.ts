import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const writeCall = {
  id: 'call',
  name: 'write_file',
  args: { file_path: 'visible.txt', content: 'written', sandbox_permissions: 'workspace-write', justification: 'Write the requested file' },
};

/**
 * A workspace whose single session asks for one approval, then finishes.
 * @param hostOptions - composition options, e.g. a short status heartbeat.
 */
async function setup(hostOptions: { statusHeartbeatMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-web-status-'));
  roots.push(root);
  const workspacePath = join(root, 'status');
  await mkdir(workspacePath);
  await writeFile(join(workspacePath, 'visible.txt'), 'original');
  const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
  const workspace = await workspaces.add(workspacePath);
  const store = new SessionStore(join(root, 'sessions'));
  const handle = await store.create({ id: 'status-session', workspace: workspace.path, cwd: workspace.path });
  await handle.append(createInitialDshPermissionEvent('read-only'));
  const broker = new ApprovalBroker();
  const host = await startWebHost({
    workspaces,
    store,
    approvalBroker: broker,
    ...hostOptions,
    createSession: (target, session, permissions) => new Session({
      cwd: target.path,
      session,
      dshPermissions: permissions,
      approve: broker.handler(target.path, session.id),
      model: new FakeModel([toolCallResponse([writeCall]), textResponse('done')], { onExhausted: textResponse('done') }),
    }),
  });
  hosts.push(host);
  const base = host.address()!;
  const sessions = `${base}/api/workspaces/${encodeURIComponent(workspace.id)}/sessions`;
  return { base, host, workspace, sessions, path: `${sessions}/status-session` };
}

/** Read one SSE data frame, failing instead of hanging when the host stays silent. */
function frames(response: Response) {
  const source = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next(timeout = 4_000): Promise<Record<string, unknown>> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            for (;;) {
              const index = buffer.indexOf('\n\n');
              if (index !== -1) {
                const frame = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                if (frame.startsWith('data: ')) return JSON.parse(frame.slice(6)) as Record<string, unknown>;
                continue;
              }
              const part = await source.read();
              if (part.done) throw new Error('status stream ended');
              buffer += decoder.decode(part.value, { stream: true });
            }
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('timed out waiting for a status frame')), timeout);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    cancel(): void {
      void source.cancel();
    },
  };
}

async function listed(sessions: string): Promise<Record<string, unknown>> {
  const body = await (await fetch(sessions)).json() as { sessions: Array<Record<string, unknown>> };
  const row = body.sessions.find((session) => session.id === 'status-session');
  if (row === undefined) throw new Error('listed session missing');
  return row;
}

async function waitForList(
  sessions: string,
  predicate: (row: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    const row = await listed(sessions);
    if (predicate(row)) return row;
    if (Date.now() > deadline) throw new Error(`session list never matched: ${JSON.stringify(row)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Find the pending approval's request id in a follow snapshot or a live prompt frame. */
function promptId(frame: Record<string, unknown>): string | undefined {
  if (frame.type === 'permission.requested' && typeof frame.requestId === 'string') return frame.requestId;
  const events = Array.isArray(frame.events) ? frame.events : [];
  for (const event of events) {
    if (typeof event === 'object' && event !== null
      && (event as { type?: unknown }).type === 'permission.requested') {
      const requestId = (event as { requestId?: unknown }).requestId;
      if (typeof requestId === 'string') return requestId;
    }
  }
  return undefined;
}

async function answer(path: string): Promise<void> {
  const follow = frames(await fetch(`${path}/follow`));
  const requestId = promptId(await follow.next());
  follow.cancel();
  if (requestId === undefined) throw new Error('the turn never asked for approval');
  const response = await fetch(`${path}/approvals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId, decision: 'allow' }),
  });
  expect(response.status).toBe(200);
}

describe('workspace session status stream', () => {
  it('pushes run state and the waiting interaction to clients that follow no turn', async () => {
    const { base, workspace, sessions, path } = await setup();
    const status = frames(await fetch(`${base}/api/workspaces/${workspace.id}/events`));

    // A quiet session carries no run state in the list either.
    const idle = await listed(sessions);
    expect(idle).toMatchObject({ id: 'status-session', running: false });
    expect(idle.pending).toBeUndefined();

    const sending = fetch(`${path}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', prefer: 'respond-async' },
      body: JSON.stringify({ text: 'write the file' }),
    });
    expect((await sending).status).toBe(202);

    expect(await status.next()).toEqual({
      type: 'session.status', sessionId: 'status-session', running: true, pending: null,
    });
    await waitForList(sessions, (row) => row.running === true);

    // The approval is what the row must surface: work only the user can unblock.
    expect(await status.next()).toEqual({
      type: 'session.status', sessionId: 'status-session', running: true, pending: 'approval',
    });
    await waitForList(sessions, (row) => row.pending === 'approval');

    // Answering the prompt clears the wait without ending the run.
    const follow = frames(await fetch(`${path}/follow`));
    const requestId = promptId(await follow.next());
    follow.cancel();
    expect(requestId).toBeDefined();
    expect((await fetch(`${path}/approvals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, decision: 'allow' }),
    })).status).toBe(200);
    expect(await status.next()).toEqual({
      type: 'session.status', sessionId: 'status-session', running: true, pending: null,
    });

    // Finishing publishes a settled row. The list contract is only running and
    // pending; the persisted outcome is read from the session's trace events.
    expect(await status.next()).toEqual({
      type: 'session.status', sessionId: 'status-session', running: false, pending: null,
    });
    const finished = await waitForList(sessions, (row) => row.running === false);
    expect(finished.pending).toBeUndefined();
    expect(finished.lastTurn).toBeUndefined();
    const detail = await (await fetch(`${path}`)).json() as { events: Array<{ type: string; data?: { reason?: string } }> };
    expect(detail.events.findLast((event) => event.type === 'trace/turn.end')).toMatchObject({ data: { reason: 'end_turn' } });
    status.cancel();
  });

  it('announces a run that started before a client attached', async () => {
    const { base, workspace, sessions, path } = await setup();
    const sending = fetch(`${path}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', prefer: 'respond-async' },
      body: JSON.stringify({ text: 'write the file' }),
    });
    expect((await sending).status).toBe(202);
    await waitForList(sessions, (row) => row.pending === 'approval');

    const status = frames(await fetch(`${base}/api/workspaces/${workspace.id}/events`));
    expect(await status.next()).toEqual({
      type: 'session.status', sessionId: 'status-session', running: true, pending: 'approval',
    });
    status.cancel();
    // Let the turn finish before the test root is removed, so its session log is
    // not still being written when cleanup runs.
    await answer(path);
    await waitForList(sessions, (row) => row.running === false);
  });

  it('closes the status stream when the workspace is unregistered', async () => {
    const { base, workspace } = await setup();
    const status = frames(await fetch(`${base}/api/workspaces/${workspace.id}/events`));
    const gone = fetch(`${base}/api/workspaces/${encodeURIComponent(workspace.id)}`, { method: 'DELETE' });
    await expect(status.next()).rejects.toThrow();
    expect((await gone).status).toBe(200);
  });
});

/** Read a status stream as raw text so comment heartbeats are visible. */
function rawStream(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    get seen(): string {
      return buffer;
    },
    /** Read until `predicate` accepts everything seen so far. */
    async until(predicate: (seen: string) => boolean, timeout = 4_000): Promise<string> {
      const deadline = Date.now() + timeout;
      while (!predicate(buffer)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for stream text: ${JSON.stringify(buffer)}`);
        const part = await reader.read();
        if (part.done) throw new Error(`status stream ended: ${JSON.stringify(buffer)}`);
        buffer += decoder.decode(part.value, { stream: true });
      }
      return buffer;
    },
    /** Whether the stream already ended, whether cleanly or with an aborted socket. */
    async ended(): Promise<boolean> {
      try {
        const part = await reader.read();
        return part.done === true || part.value === undefined;
      } catch {
        // A destroyed socket ends the stream too.
        return true;
      }
    },
    async cancel(): Promise<void> {
      await reader.cancel();
    },
  };
}

describe('workspace status stream heartbeat', () => {
  it('keeps an idle stream alive with comment lines instead of frames', async () => {
    const { base, workspace } = await setup({ statusHeartbeatMs: 20 });
    const stream = rawStream(await fetch(`${base}/api/workspaces/${workspace.id}/events`));
    const seen = await stream.until((text) => (text.match(/: ping/g) ?? []).length >= 2, 4_000);
    expect(seen).toContain(': connected\n\n');
    // A heartbeat is a comment, so it never becomes a frame the client parses.
    expect(seen.split('\n').filter((line) => line.startsWith('data: '))).toEqual([]);
    await stream.cancel();
  });

  it('stops writing once the client closes the stream', async () => {
    const { base, workspace } = await setup({ statusHeartbeatMs: 20 });
    const stream = rawStream(await fetch(`${base}/api/workspaces/${workspace.id}/events`));
    await stream.until((text) => text.includes(': ping'), 4_000);
    await stream.cancel();
    // Several heartbeat periods pass with nothing written to a closed stream.
    await new Promise((resolve) => setTimeout(resolve, 120));
    // Nothing was written to the closed stream: it is finished with no extra bytes.
    expect(await stream.ended()).toBe(true);
  });

  it('ends the stream when the host closes', async () => {
    const { base, host, workspace } = await setup({ statusHeartbeatMs: 20 });
    const stream = rawStream(await fetch(`${base}/api/workspaces/${workspace.id}/events`));
    await stream.until((text) => text.includes(': ping'), 4_000);
    await host.close();
    // All the pending listeners are dropped, so the client's stream ends here.
    hosts.length = 0;
    expect(await stream.ended()).toBe(true);
  });
});
