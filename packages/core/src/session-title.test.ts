import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createInitialDshPermissionEvent,
  projectDshPermissions,
  snapshotDshPermissions,
} from './permissions/dsh-permissions';
import { FakeModel, textResponse } from './providers/fake';
import { Session } from './session';
import { SessionStore } from './session/store';
import { projectMessages } from './session/projection';
import {
  SESSION_TITLE_EVENT,
  fallbackSessionTitle,
  foldSessionTitle,
  normalizeSessionTitle,
  titleFromModelOutput,
} from './session/title';

const permissions = snapshotDshPermissions(projectDshPermissions([createInitialDshPermissionEvent('read-only')]));

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition was not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createSession() {
  const cwd = await mkdtemp(join(tmpdir(), 'omniagent-title-'));
  const handle = await new SessionStore(join(cwd, 'sessions')).create({ id: 'agent', workspace: cwd, cwd });
  return { cwd, handle };
}

describe('session titles', () => {
  it('normalizes terminal controls and derives a deterministic fallback', () => {
    expect(normalizeSessionTitle('\u001b[31m  hello\n\tworld  \u001b[0m', 80)).toBe('hello world');
    expect(fallbackSessionTitle('Fix the login bug in the auth flow', 4, 80)).toBe('Fix the login bug');
    expect(fallbackSessionTitle('你好 世界', 5, 4)).toBe('你');
    expect(titleFromModelOutput('\n**Fix login bug**\nextra')).toBe('Fix login bug');
  });

  it('folds the latest session/title event', () => {
    const folded = foldSessionTitle([
      {
        seq: 0,
        ts: 10,
        type: SESSION_TITLE_EVENT,
        data: { title: 'Old title', messageSeqs: [1], source: { kind: 'fallback' } },
      },
      {
        seq: 1,
        ts: 20,
        type: SESSION_TITLE_EVENT,
        data: {
          title: 'New title',
          messageSeqs: [1, 2],
          source: { kind: 'provider', provider: 'test', model: { provider: 'test', model: 'fake' } },
        },
      },
    ]);
    expect(folded).toMatchObject({
      title: 'New title',
      messageSeqs: [1, 2],
      source: { kind: 'provider', provider: 'test', model: { provider: 'test', model: 'fake' } },
      eventSeq: 1,
      updatedAt: 20,
    });
  });

  it('writes the fallback immediately and replaces it with a model title', async () => {
    const { cwd, handle } = await createSession();
    try {
      const main = new FakeModel([textResponse('done')]);
      const title = new FakeModel([textResponse('Fix login bug')]);
      const session = new Session({
        cwd,
        dshPermissions: permissions,
        model: main,
        modelId: 'fake-main',
        session: handle,
        title: { model: title, modelId: 'fake-title' },
      });

      const events: Array<{ type: string }> = [];
      for await (const event of session.send('Fix the login bug in the auth flow')) {
        events.push(event);
      }
      expect(events[0]).toMatchObject({ type: 'session.title', title: 'Fix the login bug in' });

      const titleEvents = handle.events.filter((event) => event.type === SESSION_TITLE_EVENT);
      expect(titleEvents[0]?.data).toMatchObject({
        title: 'Fix the login bug in',
        source: { kind: 'fallback' },
      });
      await waitFor(() => foldSessionTitle(handle.events)?.source.kind === 'provider');
      expect(foldSessionTitle(handle.events)).toMatchObject({
        title: 'Fix login bug',
        source: { kind: 'provider', provider: 'fake', model: { provider: 'fake', model: 'fake-title' } },
      });
      expect(title.requests[0]).toMatchObject({ model: 'fake-title', tools: [], maxTokens: 4_096 });
      expect(JSON.stringify(title.requests[0]?.messages)).toContain('Fix the login bug in the auth flow');
      expect(projectMessages(handle.events).some((message) => message.role === 'system')).toBe(false);
      expect(handle.events.filter((event) => event.type === SESSION_TITLE_EVENT)).toHaveLength(2);

      const summary = (await new SessionStore(join(cwd, 'sessions')).list())[0];
      expect(summary).toMatchObject({ title: 'Fix login bug', blank: false });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps the fallback when the title model fails', async () => {
    const { cwd, handle } = await createSession();
    try {
      const main = new FakeModel([textResponse('done')]);
      const title = new FakeModel([]);
      const session = new Session({
        cwd,
        dshPermissions: permissions,
        model: main,
        modelId: 'fake-main',
        session: handle,
        title: { model: title, modelId: 'fake-title' },
      });

      for await (const _event of session.send('Review the deployment')) {
        // consume the turn
      }

      await waitFor(() => title.requests.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const titles = handle.events.filter((event) => event.type === SESSION_TITLE_EVENT);
      expect(titles).toHaveLength(1);
      expect(titles[0]?.data).toMatchObject({ title: 'Review the deployment', source: { kind: 'fallback' } });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses the local fallback when only title limits are configured', async () => {
    const { cwd, handle } = await createSession();
    try {
      let summary = (await new SessionStore(join(cwd, 'sessions')).list())[0];
      expect(summary).toMatchObject({ blank: true });
      expect(summary?.title).toBeUndefined();

      const session = new Session({
        cwd,
        dshPermissions: permissions,
        model: new FakeModel([textResponse('done')]),
        modelId: 'fake-main',
        session: handle,
        title: {},
      });
      for await (const _event of session.send('Hello there, agent')) {
        // consume the turn
      }

      const titles = handle.events.filter((event) => event.type === SESSION_TITLE_EVENT);
      expect(titles).toHaveLength(1);
      expect(titles[0]?.data).toMatchObject({ title: 'Hello there, agent', source: { kind: 'fallback' } });
      summary = (await new SessionStore(join(cwd, 'sessions')).list())[0];
      expect(summary).toMatchObject({ title: 'Hello there, agent', blank: false });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not title a session when title support is not configured', async () => {
    const { cwd, handle } = await createSession();
    try {
      const session = new Session({
        cwd,
        dshPermissions: permissions,
        model: new FakeModel([textResponse('done')]),
        modelId: 'fake-main',
        session: handle,
      });
      for await (const _event of session.send('No title here')) {
        // consume the turn
      }
      expect(handle.events.some((event) => event.type === SESSION_TITLE_EVENT)).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not let a background title event reorder the session summary', async () => {
    const { cwd, handle } = await createSession();
    try {
      await handle.append({ type: 'message/user', data: { text: 'hello' }, ts: 1_000 });
      await handle.append({
        type: SESSION_TITLE_EVENT,
        data: { title: 'hello', messageSeqs: [0], source: { kind: 'fallback' } },
        ts: 5_000,
      });
      const summary = (await new SessionStore(join(cwd, 'sessions')).list())[0];
      expect(summary).toMatchObject({ title: 'hello', blank: false, updatedAt: 1_000 });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
