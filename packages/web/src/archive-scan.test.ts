import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore, foldSessionArchived } from '@omniagent/core';
import { scanAutomaticArchives, sessionActivityKey } from './archive-scan';

const DAY = 24 * 60 * 60 * 1000;

describe('automatic archive scan', () => {
  it('archives idle root sessions and skips pinned, running, child and fresh ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-archive-scan-'));
    const store = new SessionStore(join(root, 'sessions'));
    const now = 10 * DAY;
    const stale = await store.create({ id: 'stale', workspace: '/workspace', cwd: '/workspace' });
    await stale.append({ type: 'message/user', data: { text: 'old' }, ts: now - 5 * DAY });
    const fresh = await store.create({ id: 'fresh', workspace: '/workspace', cwd: '/workspace' });
    await fresh.append({ type: 'message/user', data: { text: 'new' }, ts: now - DAY });
    const pinned = await store.create({ id: 'pinned', workspace: '/workspace', cwd: '/workspace' });
    await pinned.append({ type: 'message/user', data: { text: 'keep' }, ts: now - 8 * DAY });
    await pinned.append({ type: 'session/pinned', data: { pinned: true }, ts: now - DAY });
    const child = await store.create({
      id: 'child', workspace: '/workspace', cwd: '/workspace', parentSessionId: 'stale', depth: 1,
    });
    await child.append({ type: 'message/user', data: { text: 'child' }, ts: now - 8 * DAY });
    const busy = await store.create({ id: 'busy', workspace: '/workspace', cwd: '/workspace' });
    await busy.append({ type: 'message/user', data: { text: 'running' }, ts: now - 8 * DAY });

    const first = await scanAutomaticArchives(
      store,
      { enabled: true, retentionMs: 3 * DAY },
      new Set([sessionActivityKey('/workspace', 'busy')]),
      now,
    );
    expect(first.archived).toBe(1);
    expect(foldSessionArchived((await store.open('/workspace', 'stale')).events)).toBe(true);
    expect(foldSessionArchived((await store.open('/workspace', 'fresh')).events)).toBe(false);
    expect(foldSessionArchived((await store.open('/workspace', 'pinned')).events)).toBe(false);
    expect(foldSessionArchived((await store.open('/workspace', 'child')).events)).toBe(false);
    expect(foldSessionArchived((await store.open('/workspace', 'busy')).events)).toBe(false);

    // A second pass must not append another archive event to the same session.
    const second = await scanAutomaticArchives(store, { enabled: true, retentionMs: 3 * DAY }, new Set(), now);
    expect(second.archived).toBe(1);
    expect((await store.open('/workspace', 'stale')).events.filter((event) => event.type === 'session/archived')).toHaveLength(1);
    expect(foldSessionArchived((await store.open('/workspace', 'busy')).events)).toBe(true);
  });

  it('does nothing while automatic archiving is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-archive-scan-'));
    const store = new SessionStore(join(root, 'sessions'));
    const handle = await store.create({ id: 'stale', workspace: '/workspace', cwd: '/workspace' });
    await handle.append({ type: 'message/user', data: { text: 'old' }, ts: 1 });
    const result = await scanAutomaticArchives(store, { enabled: false, retentionMs: DAY }, new Set(), 10 * DAY);
    expect(result).toEqual({ archived: 0 });
    expect((await store.open('/workspace', 'stale')).events.some((event) => event.type === 'session/archived')).toBe(false);
  });
});
