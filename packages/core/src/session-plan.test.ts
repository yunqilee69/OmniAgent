import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './protocol/events';
import { FakeModel, textResponse, toolCallResponse } from './providers/fake';
import { Session } from './session';
import { PLAN_MODE_EVENT, projectPlanMode } from './session/plan';
import { SessionStore } from './session/store';
import {
  createInitialDshPermissionEvent,
  projectDshPermissions,
  snapshotDshPermissions,
} from './permissions/dsh-permissions';

const permissions = snapshotDshPermissions(projectDshPermissions([createInitialDshPermissionEvent('read-only')]));

async function collect(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'omniagent-plan-session-'));
}

describe('Session plan mode', () => {
  it('exposes guidance and exit_plan_mode only while active, then exits on approval', async () => {
    const cwd = await root();
    try {
      const store = new SessionStore(join(cwd, 'sessions'));
      const handle = await store.create({ id: 'parent', workspace: cwd, cwd });
      await handle.append(createInitialDshPermissionEvent('read-only'));
      await handle.append({ type: PLAN_MODE_EVENT, data: { active: true } });
      const model = new FakeModel([
        toolCallResponse([{ id: 'exit', name: 'exit_plan_mode', args: { plan: '# Plan\n\nImplement it.' } }]),
        textResponse('implemented'),
      ]);
      const reviewPlan = vi.fn(async () => ({ approved: true }));
      const session = new Session({
        cwd,
        dshPermissions: permissions,
        model,
        modelId: 'fake',
        reviewPlan,
        session: handle,
      });
      expect(session.planMode).toBe(true);
      expect(session.systemPrompt).toContain('You are in plan mode.');
      expect(session.systemPrompt).toContain('exit_plan_mode');

      const events = await collect(session.send('make a plan'));
      expect(reviewPlan).toHaveBeenCalledWith('# Plan\n\nImplement it.', expect.any(AbortSignal));
      expect(events.find((event) => event.type === 'tool.result')).toMatchObject({
        result: { name: 'exit_plan_mode', ok: true },
      });
      expect(session.planMode).toBe(false);
      expect(projectPlanMode(handle.events)).toEqual({ active: false });

      const first = model.requests[0]!;
      expect(first.system).toContain('You are in plan mode.');
      expect(first.tools?.map((tool) => tool.name)).toContain('exit_plan_mode');
      const second = model.requests[1]!;
      expect(second.system).not.toContain('You are in plan mode.');
      expect(second.tools?.map((tool) => tool.name)).not.toContain('exit_plan_mode');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps plan mode active and feeds review comments back when the user continues planning', async () => {
    const cwd = await root();
    try {
      const store = new SessionStore(join(cwd, 'sessions'));
      const handle = await store.create({ id: 'parent', workspace: cwd, cwd });
      await handle.append(createInitialDshPermissionEvent('read-only'));
      await handle.append({ type: PLAN_MODE_EVENT, data: { active: true } });
      const model = new FakeModel([
        toolCallResponse([{ id: 'exit', name: 'exit_plan_mode', args: { plan: '# Plan\n\nFirst draft.' } }]),
        textResponse('revising'),
      ]);
      const session = new Session({
        cwd,
        dshPermissions: permissions,
        model,
        modelId: 'fake',
        reviewPlan: async () => ({ approved: false, feedback: 'Cover the failure path.' }),
        session: handle,
      });
      const events = await collect(session.send('plan'));
      expect(session.planMode).toBe(true);
      const result = events.find((event) => event.type === 'tool.result');
      expect(result?.type === 'tool.result' ? result.result.content : '').toContain('Cover the failure path.');
      expect(projectPlanMode(handle.events)).toEqual({ active: true });
      expect(model.requests[1]?.tools?.map((tool) => tool.name)).toContain('exit_plan_mode');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('denies a stale exit_plan_mode call when the mode is inactive', async () => {
    const cwd = await root();
    try {
      const handle = await new SessionStore(join(cwd, 'sessions')).create({ id: 'parent', workspace: cwd, cwd });
      await handle.append(createInitialDshPermissionEvent('read-only'));
      const reviewPlan = vi.fn(async () => ({ approved: true }));
      const session = new Session({
        cwd,
        dshPermissions: permissions,
        model: new FakeModel([
          toolCallResponse([{ id: 'exit', name: 'exit_plan_mode', args: { plan: '# Plan' } }]),
          textResponse('ok'),
        ]),
        modelId: 'fake',
        reviewPlan,
        session: handle,
      });
      const events = await collect(session.send('go'));
      expect(reviewPlan).not.toHaveBeenCalled();
      expect(events.find((event) => event.type === 'permission.decided')).toMatchObject({ decision: 'deny' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
