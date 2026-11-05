import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelClient, ModelRequest } from '../providers/types';
import { FakeModel, textResponse } from '../providers/fake';
import { SubagentManager } from './manager';
import type { SubagentManagerOptions } from './manager';
import { Session } from '../session';
import { SessionStore } from '../session/store';
import {
  createInitialDshPermissionEvent,
  projectDshPermissions,
  snapshotDshPermissions,
} from '../permissions/dsh-permissions';
import type { ModelChoice, SessionModelSelection } from '../session/model-selection';

const roots: string[] = [];
const managers: SubagentManager[] = [];

const permissions = snapshotDshPermissions(projectDshPermissions([createInitialDshPermissionEvent('workspace-write')]));
const parentSelection: SessionModelSelection = { version: 1, provider: 'p', model: 'parent-model' };
const catalog: ModelChoice[] = [
  { provider: 'p', model: 'parent-model', name: 'Parent' },
  { provider: 'p', model: 'child-model', name: 'Child' },
];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

async function waitFor(check: () => boolean | Promise<boolean>, message = 'condition'): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(options: Partial<SubagentManagerOptions> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'omniagent-subagent-'));
  roots.push(cwd);
  const store = new SessionStore(join(cwd, 'sessions'));
  const parentHandle = await store.create({ id: 'parent', workspace: cwd, cwd });
  await parentHandle.append(createInitialDshPermissionEvent('workspace-write'));
  const parentModel = new FakeModel([], { onExhausted: textResponse('parent acknowledged') });
  const parent = new Session({
    cwd,
    workspace: cwd,
    model: parentModel,
    modelId: 'parent-model',
    modelSelection: parentSelection,
    dshPermissions: permissions,
    session: parentHandle,
  });
  const modelSelections: Array<SessionModelSelection | undefined> = [];
  const manager = new SubagentManager({
    store,
    createModel: options.createModel ?? ((selection) => {
      modelSelections.push(selection);
      return new FakeModel([], { onExhausted: textResponse('child acknowledged') });
    }),
    modelIdFor: (selection) => selection?.model,
    modelCatalog: catalog,
    defaultModelSelection: parentSelection,
    maxDepth: 2,
    maxActive: 4,
    ...options,
  });
  managers.push(manager);
  return { cwd, store, parentHandle, parent, manager, modelSelections };
}

describe('SubagentManager', () => {
  it('starts an async child with inherited permissions, explicit model, and a completion notice', async () => {
    const childModel = new FakeModel([textResponse('child result')]);
    const choices: Array<SessionModelSelection | undefined> = [];
    const { store, parentHandle, parent, manager } = await fixture({
      createModel: (selection) => { choices.push(selection); return childModel; },
    });

    const started = await manager.start(parent, {
      description: 'Research the API',
      prompt: 'Inspect the API surface.',
      provider: 'p',
      model: 'child-model',
    });
    expect(started.status).toBe('running');
    const outcome = await manager.wait(parent, started.id, 4_000, new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'completed', result: 'child result' });
    expect(choices).toEqual([{ version: 1, provider: 'p', model: 'child-model' }]);

    const childHandle = await store.open(parent.workspace!, started.id);
    expect(childHandle.header).toMatchObject({
      parentSessionId: 'parent', depth: 1, description: 'Research the API',
    });
    expect(projectDshPermissions(childHandle.events)).toEqual({ status: 'ready', preset: 'workspace-write' });
    expect(childHandle.events).toContainEqual(expect.objectContaining({
      type: 'model/selected', data: { version: 1, provider: 'p', model: 'child-model' },
    }));

    await waitFor(() => parentHandle.events.some((event) => event.type === 'subagent/end'), 'parent settlement');
    expect(parentHandle.events).toContainEqual(expect.objectContaining({
      type: 'subagent/start', data: expect.objectContaining({ id: started.id, parentId: 'parent', depth: 1 }),
    }));
    expect(parentHandle.events).toContainEqual(expect.objectContaining({
      type: 'subagent/end', data: expect.objectContaining({ childId: started.id, status: 'completed', result: 'child result' }),
    }));
    await waitFor(() => parentHandle.events.some((event) => event.type === 'subagent/notice'), 'parent notice');
    const children = await manager.list(parent);
    expect(children).toEqual([expect.objectContaining({ id: started.id, status: 'completed', description: 'Research the API' })]);
  });

  it('continues an idle child and lazily resumes a persisted child in a new manager', async () => {
    const firstModel = new FakeModel([textResponse('first result'), textResponse('second result')]);
    const { store, parentHandle, parent, manager } = await fixture({ createModel: () => firstModel });
    const { id } = await manager.start(parent, {
      description: 'worker', prompt: 'first', provider: 'p', model: 'child-model',
    });
    expect((await manager.wait(parent, id, 4_000, new AbortController().signal)).result).toBe('first result');

    const second = await manager.send(parent, id, 'do more');
    expect(second.messageId).toEqual(expect.any(String));
    expect((await manager.wait(parent, id, 4_000, new AbortController().signal)).result).toBe('second result');
    await waitFor(async () => (await store.open(parent.workspace!, id)).events.some((event) => {
      if (event.type !== 'message/user' || typeof event.data !== 'object' || event.data === null) return false;
      return String((event.data as Record<string, unknown>).text).includes('do more');
    }), 'steering message');

    const thirdModel = new FakeModel([textResponse('third result')]);
    const resumedSelections: Array<SessionModelSelection | undefined> = [];
    const resumed = new SubagentManager({
      store,
      createModel: (selection) => { resumedSelections.push(selection); return thirdModel; },
      modelIdFor: (selection) => selection?.model,
      modelCatalog: catalog,
      defaultModelSelection: parentSelection,
      maxDepth: 2,
      maxActive: 4,
    });
    managers.push(resumed);
    await resumed.send(parent, id, 'after restart');
    expect((await resumed.wait(parent, id, 4_000, new AbortController().signal)).result).toBe('third result');
    expect(resumedSelections).toEqual([{ version: 1, provider: 'p', model: 'child-model' }]);
    await waitFor(() => parentHandle.events.some((event) => event.type === 'subagent/notice'
      && typeof event.data === 'object' && event.data !== null
      && (event.data as Record<string, unknown>).childId === id), 'resumed parent notice');
  });

  it('enforces depth and capacity and interrupts a running descendant', async () => {
    const slow = (request: ModelRequest): Promise<never> => new Promise((_resolve, reject) => {
      if (request.signal?.aborted) return reject(request.signal.reason);
      request.signal?.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
    });
    const model: ModelClient = { name: 'slow', complete: slow };
    const { parent, manager } = await fixture({ createModel: () => model, maxDepth: 1, maxActive: 1 });
    const started = await manager.start(parent, { description: 'slow', prompt: 'wait' });
    await expect(manager.start(parent, { description: 'second', prompt: 'wait' })).rejects.toThrow(/capacity/);
    expect(await manager.interrupt(parent, started.id)).toBe(true);
    const outcome = await manager.wait(parent, started.id, 4_000, new AbortController().signal);
    expect(outcome).toMatchObject({ id: started.id, status: 'interrupted' });
    expect(await manager.interrupt(parent, started.id)).toBe(false);

    const shallow = await fixture({ maxDepth: 0 });
    expect(shallow.manager.canStart(shallow.parent)).toBe(false);
    await expect(shallow.manager.start(shallow.parent, { description: 'no', prompt: 'no' })).rejects.toThrow(/depth/);
    await expect(manager.start(parent, { description: 'outside', prompt: 'x', cwd: '../escape' })).rejects.toThrow();
    await expect(manager.start(parent, { description: 'unknown', prompt: 'x', provider: 'p', model: 'missing' }))
      .rejects.toThrow(/not available/);
  });
});
