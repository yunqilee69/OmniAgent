import { mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeSegment, SessionLog, SessionStore, sessionPath, workspaceKey } from './store';
import type { SessionEvent } from './types';

function legacyPath(root: string, id: string): string {
  return join(root, '--a-b--', id, 'session.jsonl');
}

function legacyAliasPath(root: string, workspace: string, id: string): string {
  const slug = workspace.split(/[\\/:]+/).map((part) => part ? encodeSegment(part) : '')
    .join('-').replace(/^-+/, '').slice(0, 251) || 'root';
  return join(root, `--${slug}--`, encodeSegment(id), 'session.jsonl');
}

async function writeSession(path: string, workspace: string, id: string, agentId: string, events: SessionEvent[] = []): Promise<string> {
  const header = { type: 'session', version: 1, id, agentId, workspace, cwd: workspace, createdAt: 1 };
  const text = [header, ...events].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
  return text;
}

describe('SessionStore', () => {
  it('creates private session logs and refuses to rewrite a corrupt tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const handle = await store.create({ id: 'agent', workspace: '/workspace', cwd: '/workspace' });
    const path = sessionPath(root, '/workspace', 'agent');
    expect((await stat(dirname(path))).mode & 0o077).toBe(0);
    expect((await stat(path)).mode & 0o077).toBe(0);
    await handle.append({ type: 'user/message', data: { text: 'hello' } });
    const corrupted = `${await readFile(path, 'utf8')} {"seq":`;
    await writeFile(path, corrupted, 'utf8');
    await expect(new SessionStore(root).open('/workspace', 'agent')).rejects.toThrow('invalid session event');
    expect(await readFile(path, 'utf8')).toBe(corrupted);
    expect((await stat(path)).mode & 0o077).toBe(0);
  });

  it('stores sessions under a safe workspace and agent path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const log = await store.create({
      id: 'agent/one',
      workspace: '/Users/example/project',
      cwd: '/Users/example/project',
    });

    await log.append({ type: 'user/message', data: { text: 'hello' } });
    await log.flush();

    expect(sessionPath(root, '/Users/example/project', 'agent/one')).toContain('agent~002Fone');
    expect((await store.list())[0]?.id).toBe('agent/one');
    expect((await store.open('/Users/example/project', 'agent/one')).events).toHaveLength(1);
  });

  it('persists each appended event before flush is called', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const log = await store.create({ id: 'agent', workspace: '/workspace', cwd: '/workspace' });
    await log.append({ type: 'user/message', data: { text: 'durable' } });

    const reopened = await new SessionStore(root).open('/workspace', 'agent');
    expect(reopened.events).toHaveLength(1);
  });

  it.each(['open', 'flush'] as const)(
    'does not retain or persist a failed permission preset append on %s',
    async (recovery) => {
      const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
      const store = new SessionStore(root);
      const created = await store.create({ id: 'agent', workspace: '/workspace', cwd: '/workspace' });
      const prior = await created.append({ type: 'user/message', data: { text: 'keep' } });
      const handle = await store.open('/workspace', 'agent');
      const path = sessionPath(root, '/workspace', 'agent');
      const original = await readFile(path, 'utf8');
      const moved = `${path}.moved`;
      await rename(path, moved);

      await expect(handle.append({
        type: 'permission/dsh-preset', data: { version: 1, preset: 'danger-full-access' },
      })).rejects.toThrow();
      expect.soft(handle.events).toEqual([prior]);

      await rename(moved, path);
      if (recovery === 'open') await new SessionStore(root).open('/workspace', 'agent');
      else await handle.flush();

      expect(await readFile(path, 'utf8')).toBe(original);
      expect((await new SessionStore(root).open('/workspace', 'agent')).events).toEqual([prior]);
    },
  );

  it('preserves the exact existing bytes when appending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const path = sessionPath(root, '/a-b', 'shared');
    const header = await writeSession(path, '/a-b', 'shared', 'agent');
    const original = Buffer.concat([
      Buffer.from(`${header}{"seq":0,"ts":1,"type":"user/message","data":"`),
      Buffer.from([0xff]),
      Buffer.from('"}\n'),
    ]);
    await writeFile(path, original);
    const handle = await new SessionStore(root).open('/a-b', 'shared');
    const event = await handle.append({ type: 'user/message', data: 'next' });

    expect(await readFile(path)).toEqual(Buffer.concat([original, Buffer.from(`${JSON.stringify(event)}\n`)]));
  });

  it('appends to a large session without failing after the file is committed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const path = sessionPath(root, '/a-b', 'shared');
    const events = Array.from({ length: 150_000 }, (_, seq) => ({ seq, ts: 1, type: 'turn/start', data: null }));
    await writeSession(path, '/a-b', 'shared', 'agent', events);
    const handle = await new SessionStore(root).open('/a-b', 'shared');

    const event = await handle.append({ type: 'user/message', data: 'last' });
    expect(event.seq).toBe(events.length);
    expect(handle.events.at(-1)).toEqual(event);
    expect((await readFile(path, 'utf8')).endsWith(`${JSON.stringify(event)}\n`)).toBe(true);
  }, 20_000);

  it('repairs a valid log without a trailing newline before appending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const log = await store.create({ id: 'agent', workspace: '/workspace', cwd: '/workspace' });
    await log.append({ type: 'user/message', data: { text: 'first' } });
    await log.flush();
    const path = sessionPath(root, '/workspace', 'agent');
    const complete = await readFile(path, 'utf8');
    await writeFile(path, complete.replace(/\n$/, ''), 'utf8');

    const reopened = await new SessionStore(root).open('/workspace', 'agent');
    await reopened.append({ type: 'user/message', data: { text: 'second' } });

    const recovered = await new SessionStore(root).open('/workspace', 'agent');
    expect(recovered.events.map((event) => event.data)).toEqual([
      { text: 'first' }, { text: 'second' },
    ]);
  });

  it('repairs a header-only log without a trailing newline before appending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const created = await store.create({ id: 'agent', workspace: '/workspace', cwd: '/workspace' });
    const path = sessionPath(root, '/workspace', 'agent');
    await writeFile(path, JSON.stringify(created.header), 'utf8');

    const reopened = await new SessionStore(root).open('/workspace', 'agent');
    await reopened.append({ type: 'user/message', data: { text: 'first' } });

    const recovered = await new SessionStore(root).open('/workspace', 'agent');
    expect(recovered.events.map((event) => event.data)).toEqual([{ text: 'first' }]);
  });

  it('preserves a torn tail and refuses to open a possibly incomplete session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const log = await store.create({ id: 'agent', workspace: '/workspace', cwd: '/workspace' });
    await log.append({ type: 'user/message', data: { text: 'first' } });
    await log.flush();

    const path = sessionPath(root, '/workspace', 'agent');
    const corrupted = `${await readFile(path, 'utf8')} {"seq":`;
    await writeFile(path, corrupted, 'utf8');

    await expect(new SessionStore(root).open('/workspace', 'agent')).rejects.toThrow('invalid session event');
    expect(await readFile(path, 'utf8')).toBe(corrupted);
  });

  it('does not recover a wider DSH preset when a later restrictive event is torn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const path = sessionPath(root, '/workspace', 'agent');
    const events = [
      { seq: 0, ts: 1, type: 'permission/dsh-preset', data: { version: 1, preset: 'danger-full-access' } },
      { seq: 1, ts: 2, type: 'permission/dsh-preset', data: { version: 1, preset: 'read-only' } },
    ];
    const original = await writeSession(path, '/workspace', 'agent', 'agent', events as SessionEvent[]);
    const corrupted = original.replace(JSON.stringify(events[1]), '{"seq":1,"ts":2,"type":"permission/dsh-preset","data":');
    await writeFile(path, corrupted, 'utf8');

    await expect(new SessionStore(root).open('/workspace', 'agent')).rejects.toThrow('invalid session event');
    expect(await readFile(path, 'utf8')).toBe(corrupted);
  });


  it('rejects non-contiguous appends and unsupported versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const log = await store.create({ id: 'agent', workspace: '/workspace', cwd: '/workspace' });

    await expect(log.append({ seq: 4, type: 'user/message', data: { text: 'bad' } })).rejects.toThrow('contiguous');

    const path = sessionPath(root, '/workspace', 'future');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ type: 'session', version: 99, id: 'future', workspace: '/workspace', createdAt: 1, cwd: '/workspace' })}\n`, 'utf8');
    await expect(store.open('/workspace', 'future')).rejects.toThrow('unsupported session format');
  });

  it('rejects a torn final line and preserves the original session bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const log = await store.create({ id: 'agent', workspace: '/workspace', cwd: '/workspace' });
    await log.append({ type: 'user/message', data: { text: 'first' } });
    await log.flush();

    const path = sessionPath(root, '/workspace', 'agent');
    const corrupted = `${await readFile(path, 'utf8')}\n{"seq":`;
    await writeFile(path, corrupted, 'utf8');

    await expect(new SessionStore(root).open('/workspace', 'agent')).rejects.toThrow('invalid');
    expect(await readFile(path, 'utf8')).toBe(corrupted);
  });
  it('assigns stable distinct workspace keys even when legacy slugs collide or are truncated', () => {
    const workspaces = [
      '/a-b', '/a/b', '/a:b', '/a\\b', '/A/b',
      `/${'a'.repeat(280)}x`, `/${'a'.repeat(280)}y`,
    ];
    const keys = workspaces.map(workspaceKey);
    expect(new Set(keys).size).toBe(workspaces.length);
    expect(workspaces.map(workspaceKey)).toEqual(keys);
    expect(keys.every((key) => Buffer.byteLength(key) <= 255)).toBe(true);
  });

  it('keeps sessions with the same id in colliding workspaces independent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const left = await store.create({ id: 'shared', agentId: 'left-agent', workspace: '/a-b', cwd: '/a-b' });
    const right = await store.create({ id: 'shared', agentId: 'right-agent', workspace: '/a/b', cwd: '/a/b' });
    await left.append({ type: 'user/message', data: { text: 'left' } });
    await right.append({ type: 'user/message', data: { text: 'right' } });

    expect(sessionPath(root, '/a-b', 'shared')).not.toBe(sessionPath(root, '/a/b', 'shared'));
    const reopened = new SessionStore(root);
    expect((await reopened.open('/a-b', 'shared')).events[0]?.data).toEqual({ text: 'left' });
    expect((await reopened.open('/a/b', 'shared')).events[0]?.data).toEqual({ text: 'right' });
    expect((await reopened.list()).map(({ workspace, agentId }) => [workspace, agentId]).sort()).toEqual([
      ['/a-b', 'left-agent'], ['/a/b', 'right-agent'],
    ]);
  });

  it('opens and appends to a matching legacy session without migrating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const path = legacyPath(root, 'shared');
    const first = { seq: 0, ts: 2, type: 'user/message', data: { text: 'old' } };
    await writeSession(path, '/a-b', 'shared', 'old-agent', [first]);
    const store = new SessionStore(root);

    const handle = await store.open('/a-b', 'shared');
    expect(handle.header.agentId).toBe('old-agent');
    expect(handle.events).toEqual([first]);
    const secondHandle = await store.open('/a-b', 'shared');
    await secondHandle.append({ type: 'user/message', data: { text: 'new' } });
    expect(JSON.parse((await readFile(path, 'utf8')).trim().split('\n')[2] ?? '')).toMatchObject({ seq: 1 });
    await expect(readFile(sessionPath(root, '/a-b', 'shared'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await new SessionStore(root).list()).toMatchObject([{ id: 'shared', workspace: '/a-b', agentId: 'old-agent', eventCount: 2 }]);
  });

  it('lists and opens a legacy session with an escaped id in place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const id = 'agent/one';
    const path = legacyPath(root, encodeSegment(id));
    const text = await writeSession(path, '/a-b', id, 'old-agent');
    const store = new SessionStore(root);

    expect(await store.list()).toMatchObject([{ id, workspace: '/a-b', agentId: 'old-agent' }]);
    expect((await store.open('/a-b', id)).header.agentId).toBe('old-agent');
    expect(await readFile(path, 'utf8')).toBe(text);
    await expect(readFile(sessionPath(root, '/a-b', id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['workspace directory', (root: string) => join(root, '--other--', 'shared', 'session.jsonl')],
    ['session directory', (root: string) => join(root, '--a-b--', 'other', 'session.jsonl')],
  ])('does not list a legacy session in the wrong %s', async (_location, location) => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const path = location(root);
    const text = await writeSession(path, '/a-b', 'shared', 'agent');
    const store = new SessionStore(root);

    expect(await store.list()).toEqual([]);
    await expect(store.open('/a-b', 'shared')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path, 'utf8')).toBe(text);
  });

  it('does not let a misplaced legacy session shadow a valid legacy session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const misplaced = join(root, '--0-other--', 'shared', 'session.jsonl');
    const misplacedText = await writeSession(misplaced, '/a-b', 'shared', 'misplaced');
    const valid = legacyPath(root, 'shared');
    const validText = await writeSession(valid, '/a-b', 'shared', 'valid');
    const store = new SessionStore(root);

    expect(await store.list()).toMatchObject([{ id: 'shared', workspace: '/a-b', agentId: 'valid' }]);
    expect((await store.open('/a-b', 'shared')).header.agentId).toBe('valid');
    expect(await readFile(misplaced, 'utf8')).toBe(misplacedText);
    expect(await readFile(valid, 'utf8')).toBe(validText);
  });

  it.each(['modern', 'legacy'] as const)('keeps a %s session with a symlink workspace spelling under that spelling', async (layout) => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const directory = join(root, 'workspace');
    await mkdir(directory);
    const workspace = await realpath(directory);
    const alias = join(await realpath(root), 'workspace-alias');
    await symlink(workspace, alias, 'dir');
    expect(await realpath(alias)).toBe(workspace);
    const sessionRoot = join(root, 'sessions');
    const path = layout === 'modern'
      ? sessionPath(sessionRoot, alias, 'shared')
      : legacyAliasPath(sessionRoot, alias, 'shared');
    const text = await writeSession(path, alias, 'shared', 'agent');
    const store = new SessionStore(sessionRoot);

    expect((await store.list()).filter((summary) => summary.workspace === workspace)).toEqual([]);
    expect(await store.list()).toMatchObject([{ id: 'shared', workspace: alias }]);
    await expect(store.open(workspace, 'shared')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.open(alias, 'shared')).header.workspace).toBe(alias);
    const canonical = await store.create({ id: 'shared', workspace, cwd: workspace });
    await canonical.append({ type: 'user/message', data: 'canonical only' });
    expect((await store.open(alias, 'shared')).events).toEqual([]);
    expect((await store.open(workspace, 'shared')).events[0]?.data).toBe('canonical only');
    expect(await readFile(path, 'utf8')).toBe(text);
  });

  it('rejects creation of an existing legacy session without changing its data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const path = legacyPath(root, 'shared');
    const text = await writeSession(path, '/a-b', 'shared', 'old-agent');
    const store = new SessionStore(root);

    await expect(store.create({ id: 'shared', agentId: 'new-agent', workspace: '/a-b', cwd: '/a-b' })).rejects.toThrow('already exists');
    expect(await readFile(path, 'utf8')).toBe(text);
    await expect(readFile(sessionPath(root, '/a-b', 'shared'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not open another workspace through a colliding legacy path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const path = legacyPath(root, 'shared');
    const text = await writeSession(path, '/a-b', 'shared', 'old-agent');
    const store = new SessionStore(root);

    await expect(store.open('/a/b', 'shared')).rejects.toThrow('identity');
    const created = await store.create({ id: 'shared', agentId: 'new-agent', workspace: '/a/b', cwd: '/a/b' });
    await created.append({ type: 'user/message', data: { text: 'new workspace' } });
    expect(await readFile(path, 'utf8')).toBe(text);
    expect((await new SessionStore(root).open('/a-b', 'shared')).header.agentId).toBe('old-agent');
    expect((await new SessionStore(root).open('/a/b', 'shared')).header.agentId).toBe('new-agent');
    expect((await new SessionStore(root).list()).map(({ workspace, agentId }) => [workspace, agentId]).sort()).toEqual([
      ['/a-b', 'old-agent'], ['/a/b', 'new-agent'],
    ]);
  });

  it('deduplicates old and new files by header identity and prefers the modern file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const old = legacyPath(root, 'shared');
    const modern = sessionPath(root, '/a-b', 'shared');
    const oldText = await writeSession(old, '/a-b', 'shared', 'old-agent');
    await writeSession(modern, '/a-b', 'shared', 'new-agent', [
      { seq: 0, ts: 3, type: 'user/message', data: { text: 'modern' } },
    ]);
    const store = new SessionStore(root);

    expect(await store.list()).toMatchObject([{ id: 'shared', workspace: '/a-b', agentId: 'new-agent', eventCount: 1 }]);
    expect((await store.open('/a-b', 'shared')).header.agentId).toBe('new-agent');
    expect(await store.list()).toHaveLength(1);
    expect(await readFile(old, 'utf8')).toBe(oldText);
  });

  it.each(['modern', 'legacy'] as const)('does not create over or shadow an invalid %s log', async (layout) => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const path = layout === 'modern' ? sessionPath(root, '/a-b', 'shared') : legacyPath(root, 'shared');
    const invalid = '{"type":"session",';
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, invalid, 'utf8');
    const store = new SessionStore(root);

    await expect(store.open('/a-b', 'shared')).rejects.toThrow();
    await expect(store.create({ id: 'shared', workspace: '/a-b', cwd: '/a-b' })).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(invalid);
    if (layout === 'legacy') await expect(readFile(sessionPath(root, '/a-b', 'shared'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['invalid header', 'different identity', 'invalid event'] as const)(
    'does not list a legacy session shadowed by a modern log with %s',
    async (problem) => {
      const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
      const old = legacyPath(root, 'shared');
      const modern = sessionPath(root, '/a-b', 'shared');
      const oldText = await writeSession(old, '/a-b', 'shared', 'old-agent');
      let modernText: string;
      if (problem === 'invalid header') {
        await mkdir(dirname(modern), { recursive: true });
        modernText = '{"type":"session",';
        await writeFile(modern, modernText, 'utf8');
      } else if (problem === 'different identity') {
        modernText = await writeSession(modern, '/other', 'shared', 'other-agent');
      } else {
        const header = await writeSession(modern, '/a-b', 'shared', 'new-agent');
        modernText = `${header}{broken}\n${JSON.stringify({ seq: 0, ts: 2, type: 'user/message', data: 'keep' })}\n`;
        await writeFile(modern, modernText, 'utf8');
      }
      const store = new SessionStore(root);

      expect(await store.list()).toEqual([]);
      await expect(store.open('/a-b', 'shared')).rejects.toThrow();
      expect(await readFile(old, 'utf8')).toBe(oldText);
      expect(await readFile(modern, 'utf8')).toBe(modernText);
    },
  );

  it('lists a legacy session when the modern path is a dangling symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const old = legacyPath(root, 'shared');
    const modern = sessionPath(root, '/a-b', 'shared');
    const oldText = await writeSession(old, '/a-b', 'shared', 'old-agent');
    await mkdir(dirname(modern), { recursive: true });
    await symlink('missing.jsonl', modern);
    const store = new SessionStore(root);

    expect(await store.list()).toMatchObject([{ id: 'shared', agentId: 'old-agent' }]);
    expect((await store.open('/a-b', 'shared')).header.agentId).toBe('old-agent');
    expect(await readFile(old, 'utf8')).toBe(oldText);
  });

  it('does not fall back to a legacy file when a modern file has a different identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const old = legacyPath(root, 'shared');
    const modern = sessionPath(root, '/a-b', 'shared');
    await writeSession(old, '/a-b', 'shared', 'old-agent');
    await writeSession(modern, '/other', 'shared', 'other-agent');
    const store = new SessionStore(root);

    await expect(store.open('/a-b', 'shared')).rejects.toThrow('identity');
    await expect(store.create({ id: 'shared', workspace: '/a-b', cwd: '/a-b' })).rejects.toThrow();
  });

  it('serializes concurrent creates across store instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const stores = Array.from({ length: 12 }, () => new SessionStore(root));
    const results = await Promise.allSettled(stores.map((store, index) => store.create({
      id: 'shared', agentId: `agent-${index}`, workspace: '/a-b', cwd: '/a-b',
    })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(11);
    const winner = results.find((result) => result.status === 'fulfilled');
    expect(winner?.status).toBe('fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('missing create winner');
    expect((await new SessionStore(root).open('/a-b', 'shared')).header.agentId).toBe(winner.value.header.agentId);
  });

  it('does not retain a failed append before another store writes or reopens the session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    class FailingStore extends SessionStore {
      private fail = true;
      override async append(path: string, event: SessionEvent): Promise<void> {
        if (this.fail) {
          this.fail = false;
          throw new Error('simulated write failure');
        }
        await super.append(path, event);
      }
    }
    const store = new FailingStore(root);
    const first = await store.create({ id: 'shared', workspace: '/a-b', cwd: '/a-b' });
    const second = await new SessionStore(root).open('/a-b', 'shared');
    await expect(first.append({ type: 'user/message', data: { text: 'first' } })).rejects.toThrow('simulated write failure');
    expect(first.events).toEqual([]);
    const event = await second.append({ type: 'user/message', data: { text: 'second' } });
    expect(event.seq).toBe(0);
    const reopened = await new SessionStore(root).open('/a-b', 'shared');
    expect(reopened.events).toEqual([event]);
  });

  it('uses on-disk header identity in listings even when a session was previously opened', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    await store.create({ id: 'shared', agentId: 'old-agent', workspace: '/a-b', cwd: '/a-b' });
    await writeSession(sessionPath(root, '/a-b', 'shared'), '/a-b', 'shared', 'changed-agent');

    expect(await store.list()).toMatchObject([{ id: 'shared', agentId: 'changed-agent' }]);
    expect((await store.open('/a-b', 'shared')).header.agentId).toBe('changed-agent');
  });

  it('does not retain a failed partially written event on reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    class PartiallyFailingStore extends SessionStore {
      override async append(path: string): Promise<void> {
        await writeFile(path, `${await readFile(path, 'utf8')}{"seq":`, 'utf8');
        throw new Error('simulated partial write');
      }
    }
    const store = new PartiallyFailingStore(root);
    const first = await store.create({ id: 'shared', workspace: '/a-b', cwd: '/a-b' });
    const path = sessionPath(root, '/a-b', 'shared');
    const original = await readFile(path, 'utf8');
    await expect(first.append({ type: 'user/message', data: { text: 'discard' } })).rejects.toThrow('simulated partial write');
    expect(first.events).toEqual([]);
    const reopened = await new SessionStore(root).open('/a-b', 'shared');
    expect(reopened.events).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it.each(['partial', 'complete'] as const)(
    'keeps the original log when an append writes %s data and fails',
    async (failure) => {
      const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
      class FailingStore extends SessionStore {
        fail = false;
        override async append(path: string, event: SessionEvent): Promise<void> {
          if (!this.fail) return super.append(path, event);
          const line = `${JSON.stringify(event)}\n`;
          await writeFile(path, failure === 'partial' ? line.slice(0, 12) : line, { flag: 'a' });
          throw new Error('simulated write failure');
        }
      }
      const store = new FailingStore(root);
      const first = await store.create({ id: 'shared', workspace: '/a-b', cwd: '/a-b' });
      const prior = await first.append({ type: 'user/message', data: { text: 'keep' } });
      const second = await new SessionStore(root).open('/a-b', 'shared');
      const path = sessionPath(root, '/a-b', 'shared');
      const original = await readFile(path, 'utf8');
      store.fail = true;

      await expect(first.append({ type: 'permission/dsh-preset', data: { preset: 'danger-full-access' } }))
        .rejects.toThrow('simulated write failure');
      expect.soft(first.events).toEqual([prior]);
      expect.soft(second.events).toEqual([prior]);
      expect.soft(await readFile(path, 'utf8')).toBe(original);
      expect.soft(await readdir(dirname(path))).toEqual(['session.jsonl']);

      const next = await second.append({ type: 'user/message', data: { text: 'next' } });
      expect(next.seq).toBe(1);
      expect((await new SessionStore(root).open('/a-b', 'shared')).events).toEqual([prior, next]);
    },
  );

  it('rejects an append when the session file was replaced by a different session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const handle = await new SessionStore(root).create({ id: 'shared', workspace: '/a-b', cwd: '/a-b' });
    const path = sessionPath(root, '/a-b', 'shared');
    const replacement = await writeSession(path, '/a-b', 'shared', 'different-agent');

    await expect(handle.append({ type: 'user/message', data: 'must not overwrite' })).rejects.toThrow('identity');
    expect(handle.events).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe(replacement);
  });

  it('does not recreate a session file removed during an append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const path = sessionPath(root, '/a-b', 'shared');
    const moved = `${path}.moved`;
    class MovingStore extends SessionStore {
      override async append(temporary: string, event: SessionEvent): Promise<void> {
        await super.append(temporary, event);
        await rename(path, moved);
      }
    }
    const handle = await new MovingStore(root).create({ id: 'shared', workspace: '/a-b', cwd: '/a-b' });
    const original = await readFile(path, 'utf8');

    await expect(handle.append({ type: 'user/message', data: 'must not recreate' })).rejects.toThrow();
    expect(handle.events).toEqual([]);
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(moved, 'utf8')).toBe(original);
    expect(await readdir(dirname(path))).toEqual(['session.jsonl.moved']);
  });

  it('does not overwrite a changed session log during an append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const path = sessionPath(root, '/a-b', 'shared');
    class ChangingStore extends SessionStore {
      override async append(temporary: string, event: SessionEvent): Promise<void> {
        await super.append(temporary, event);
        await writeFile(path, `${await readFile(path, 'utf8')}${JSON.stringify({ seq: 0, ts: 1, type: 'user/message', data: 'external' })}\n`);
      }
    }
    const handle = await new ChangingStore(root).create({ id: 'shared', workspace: '/a-b', cwd: '/a-b' });

    await expect(handle.append({ type: 'user/message', data: 'must not overwrite' })).rejects.toThrow();
    expect(handle.events).toEqual([]);
    expect((await new SessionStore(root).open('/a-b', 'shared')).events.map(({ data }) => data)).toEqual(['external']);
    expect(await readdir(dirname(path))).toEqual(['session.jsonl']);
  });

  it('preserves a symlinked session file when appending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const path = sessionPath(root, '/a-b', 'shared');
    const target = `${path}.target`;
    const created = await new SessionStore(root).create({ id: 'shared', workspace: '/a-b', cwd: '/a-b' });
    await rename(path, target);
    await symlink(target, path);
    const handle = await new SessionStore(root).open('/a-b', 'shared');
    const event = await handle.append({ type: 'user/message', data: 'symlink target' });

    expect(await realpath(path)).toBe(await realpath(target));
    expect((await readFile(target, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))).toEqual([created.header, event]);
    expect((await new SessionStore(root).open('/a-b', 'shared')).events).toEqual([event]);
  });

  it('does not truncate a malformed event in the middle of a log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const path = sessionPath(root, '/a-b', 'shared');
    const header = await writeSession(path, '/a-b', 'shared', 'agent');
    const text = `${header}{broken}\n${JSON.stringify({ seq: 0, ts: 2, type: 'user/message', data: 'keep' })}\n`;
    await writeFile(path, text, 'utf8');
    await expect(new SessionStore(root).open('/a-b', 'shared')).rejects.toThrow();
    await expect(new SessionStore(root).create({ id: 'shared', workspace: '/a-b', cwd: '/a-b' })).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(text);
  });

  it('does not recreate a missing log when appending through an active handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const handle = await store.create({ id: 'shared', workspace: '/a-b', cwd: '/a-b' });
    const path = sessionPath(root, '/a-b', 'shared');
    await unlink(path);
    await expect(handle.append({ type: 'user/message', data: 'do not recreate' })).rejects.toThrow();
    await expect(handle.flush()).resolves.toBeUndefined();
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent appends from handles opened by different stores', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const first = await new SessionStore(root).create({ id: 'shared', workspace: '/a-b', cwd: '/a-b' });
    const second = await new SessionStore(root).open('/a-b', 'shared');
    await Promise.all(Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? first : second).append({
      type: 'user/message', data: { index },
    })));

    const reopened = await new SessionStore(root).open('/a-b', 'shared');
    expect(reopened.events.map(({ seq }) => seq)).toEqual(Array.from({ length: 30 }, (_, index) => index));
    expect(new Set(reopened.events.map(({ data }) => (data as { index: number }).index)).size).toBe(30);
  });
});

describe('SessionLog', () => {
  it('assigns sequence numbers and exposes an immutable snapshot', async () => {
    const log = new SessionLog({ id: 'agent', workspace: '/workspace', cwd: '/workspace' });
    const event = await log.append({ type: 'turn/start', data: { turn: 1 } });
    expect(event.seq).toBe(0);
    expect(log.events).toEqual<SessionEvent[]>([event]);
    expect(Object.isFrozen(log.events)).toBe(true);
  });
});
