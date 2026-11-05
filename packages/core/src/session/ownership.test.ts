import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from './store';

describe('SessionStore ownership', () => {
  it('rejects a second live writer for the same session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    await store.create({ id: 'agent', workspace: root, cwd: root });
    await expect(store.create({ id: 'agent', workspace: root, cwd: root })).rejects.toThrow('already exists');
  });

  it('does not duplicate an active session in list results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const handle = await store.create({ id: 'agent', workspace: root, cwd: root });
    await handle.append({ type: 'user/message', data: { text: 'hello' } });
    const summaries = await store.list();
    expect(summaries.filter((summary) => summary.id === 'agent')).toHaveLength(1);
  });
});
