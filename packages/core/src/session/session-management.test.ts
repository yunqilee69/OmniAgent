import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from './store';
import { createSessionPinEvent, foldSessionPinned, SESSION_PIN_EVENT } from './pin';
import { createSessionArchiveEvent, foldSessionArchived, SESSION_ARCHIVE_EVENT } from './archive';
import { lastActivityTime } from './title';
import type { SessionEvent } from './types';

function event(seq: number, ts: number, type: string, data: unknown): SessionEvent {
  return { seq, ts, type, data };
}

describe('session pinning', () => {
  it('folds the latest pin event and treats malformed state as unpinned', () => {
    expect(foldSessionPinned([])).toBe(false);
    expect(foldSessionPinned([event(0, 1, SESSION_PIN_EVENT, { pinned: true })])).toBe(true);
    expect(foldSessionPinned([
      event(0, 1, SESSION_PIN_EVENT, { pinned: true }),
      event(1, 2, SESSION_PIN_EVENT, { pinned: false }),
    ])).toBe(false);
    expect(foldSessionPinned([event(0, 1, SESSION_PIN_EVENT, { pinned: 'yes' })])).toBe(false);
  });

  it('does not count title, pin or archive events as conversation activity', () => {
    const events = [
      event(0, 10, 'message/user', 'hello'),
      event(1, 20, 'session/title', { title: 'Greeting' }),
      event(2, 30, 'session/pinned', { pinned: true }),
      event(3, 40, 'session/archived', { archived: true }),
    ];
    expect(lastActivityTime(events, 1)).toBe(10);
  });

  it('exposes pinned state in summaries without moving updatedAt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const handle = await store.create({ id: 'pinned', workspace: '/workspace', cwd: '/workspace' });
    await handle.append({ type: 'message/user', data: 'hello', ts: 10 });
    expect(await store.list()).toMatchObject([{ id: 'pinned', updatedAt: 10 }]);

    await handle.append(createSessionPinEvent(true));
    expect(await store.list()).toMatchObject([{ id: 'pinned', pinned: true, updatedAt: 10 }]);

    await handle.append(createSessionPinEvent(false));
    expect((await store.list())[0]?.pinned).toBeUndefined();
  });
});

describe('session archiving', () => {
  it('folds the latest archive event and treats malformed state as unarchived', () => {
    expect(foldSessionArchived([])).toBe(false);
    expect(foldSessionArchived([event(0, 1, SESSION_ARCHIVE_EVENT, { archived: true })])).toBe(true);
    expect(foldSessionArchived([
      event(0, 1, SESSION_ARCHIVE_EVENT, { archived: true }),
      event(1, 2, SESSION_ARCHIVE_EVENT, { archived: false }),
    ])).toBe(false);
    expect(foldSessionArchived([event(0, 1, SESSION_ARCHIVE_EVENT, { archived: 'yes' })])).toBe(false);
  });

  it('exposes archived state in summaries while keeping the transcript on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const handle = await store.create({ id: 'archived', workspace: '/workspace', cwd: '/workspace' });
    await handle.append({ type: 'message/user', data: 'hello', ts: 10 });
    expect((await store.list())[0]?.archived).toBeUndefined();

    await handle.append(createSessionArchiveEvent(true));
    expect(await store.list()).toMatchObject([{ id: 'archived', archived: true, updatedAt: 10 }]);
    expect((await store.open('/workspace', 'archived')).events).toHaveLength(2);

    await handle.append(createSessionArchiveEvent(false));
    expect((await store.list())[0]?.archived).toBeUndefined();
  });
});

describe('session management storage', () => {
  it('creates a session with pre-existing events and contiguous sequence numbers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const handle = await store.create({
      id: 'fork',
      workspace: '/workspace',
      cwd: '/workspace',
      events: [
        { seq: 99, ts: 10, type: 'message/user', data: 'hello' },
        { seq: 100, ts: 20, type: 'message/assistant', data: { role: 'assistant', content: 'hi' } },
      ],
    });

    expect(handle.events.map(({ seq, ts }) => ({ seq, ts }))).toEqual([{ seq: 0, ts: 10 }, { seq: 1, ts: 20 }]);
    const reopened = await new SessionStore(root).open('/workspace', 'fork');
    expect(reopened.events.map(({ seq }) => seq)).toEqual([0, 1]);
  });

  it('deletes a session log and removes it from listings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const handle = await store.create({ id: 'gone', workspace: '/workspace', cwd: '/workspace' });
    await handle.append({ type: 'message/user', data: 'hello' });

    await expect(store.delete('/workspace', 'gone')).resolves.toBe(true);
    expect(await store.list()).toEqual([]);
    await expect(store.open('/workspace', 'gone')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.delete('/workspace', 'gone')).resolves.toBe(false);
  });
});
