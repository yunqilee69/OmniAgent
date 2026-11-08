import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from './protocol/events';
import { FakeModel, textResponse, toolCallResponse } from './providers/fake';
import { Session } from './session';
import { SessionStore } from './session/store';
import {
  createInitialDshPermissionEvent,
  projectDshPermissions,
  snapshotDshPermissions,
} from './permissions/dsh-permissions';

const permissions = snapshotDshPermissions(projectDshPermissions([createInitialDshPermissionEvent('read-only')]));

describe('Session background continuation', () => {
  it('wakes after a message queued at the final step instead of leaving it unread', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omniagent-continuation-'));
    try {
      const handle = await new SessionStore(join(cwd, 'sessions')).create({ id: 'agent', workspace: cwd, cwd });
      await handle.append(createInitialDshPermissionEvent('read-only'));
      const model = new FakeModel([textResponse('first'), textResponse('second')]);
      const background: AgentEvent[] = [];
      const session = new Session({
        cwd,
        dshPermissions: permissions,
        model,
        modelId: 'fake',
        session: handle,
        onBackgroundEvent: (event) => { background.push(event); },
      });

      let queued = false;
      for await (const event of session.send('start')) {
        if (event.type === 'turn.end' && !queued) {
          queued = true;
          await expect(session.deliverExternalMessage('follow up', 'agent')).resolves.toBe('queued');
          break;
        }
      }

      const deadline = Date.now() + 4_000;
      while (model.requests.length < 2) {
        if (Date.now() > deadline) throw new Error('background turn did not start');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(model.requests[1]?.messages).toContainEqual(expect.objectContaining({
        role: 'user', content: expect.arrayContaining([expect.objectContaining({ text: 'follow up' })]),
      }));
      while (background.every((event) => event.type !== 'turn.end')) {
        if (Date.now() > deadline) throw new Error('background turn did not finish');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(background).toContainEqual(expect.objectContaining({ type: 'turn.end', reason: 'end_turn' }));
      expect(handle.events.filter((event) => event.type === 'message/assistant')).toHaveLength(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('injects a direct human message into the active turn at its next step', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omniagent-steer-'));
    try {
      const handle = await new SessionStore(join(cwd, 'sessions')).create({ id: 'agent', workspace: cwd, cwd });
      await handle.append(createInitialDshPermissionEvent('read-only'));
      const model = new FakeModel([
        toolCallResponse([{ name: 'list_dir', args: { path: '.' } }]),
        textResponse('done'),
      ]);
      const session = new Session({
        cwd,
        dshPermissions: permissions,
        model,
        modelId: 'fake',
        session: handle,
      });

      let steered = false;
      for await (const event of session.send('start')) {
        if (event.type === 'tool.result' && !steered) {
          steered = true;
          await expect(session.deliverUserMessage('steer now')).resolves.toBe('queued');
        }
      }

      expect(model.requests).toHaveLength(2);
      expect(model.requests[1]?.messages).toContainEqual(expect.objectContaining({
        role: 'user', content: expect.arrayContaining([expect.objectContaining({ text: 'steer now' })]),
      }));
      expect(handle.events).toContainEqual(expect.objectContaining({
        type: 'message/user', data: { text: 'steer now' },
      }));
      await expect(session.deliverUserMessage('late')).rejects.toThrow('A turn is not active in this session');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
