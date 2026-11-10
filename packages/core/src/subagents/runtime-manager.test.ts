import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCatalog } from '../agents';
import { ConfigStore } from '../config/store';
import { FakeModel, textResponse } from '../providers/fake';
import type { ModelRequest } from '../providers/types';
import { Session } from '../session';
import { RuntimeResolver } from '../session/runtime';
import { SessionStore } from '../session/store';
import { SubagentManager } from './manager';

const roots: string[] = [];
const managers: SubagentManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-subagent-runtime-'));
  roots.push(root);
  const configDir = join(root, 'config');
  const cwd = join(root, 'workspace');
  await mkdir(join(configDir, 'agents'), { recursive: true });
  await mkdir(cwd);
  await writeFile(join(configDir, 'config.json'), JSON.stringify({
    model: 'fake',
    agentProfiles: {
      default: { tools: '*', skills: '*' },
      search: { tools: ['read_file'], skills: '*' },
    },
  }));
  await writeFile(join(configDir, 'agents', 'explorer.md'), '---\nname: Explorer\nusage: subagent\nprofile: search\n---\nEXPLORER BODY');
  await writeFile(join(configDir, 'agents', 'primary.md'), '---\nname: Primary\nusage: primary\n---\nPRIMARY BODY');
  const store = new SessionStore(join(root, 'sessions'));
  const parentHandle = await store.create({ id: 'parent', workspace: cwd, cwd });
  await parentHandle.append({ type: 'permission/dsh-preset', data: { version: 1, preset: 'workspace-write' } });
  const parent = new Session({
    cwd,
    workspace: cwd,
    model: new FakeModel([], { onExhausted: textResponse('parent') }),
    session: parentHandle,
    dshPermissions: { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
  });
  const configStore = await ConfigStore.open(join(configDir, 'config.json'));
  const agents = new AgentCatalog(join(configDir, 'agents'));
  const runtime = new RuntimeResolver({ configStore, agents });
  return { root, configDir, cwd, store, parentHandle, parent, runtime };
}

async function waitFor(check: () => boolean | Promise<boolean>, message = 'condition'): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('SubagentManager with RuntimeResolver', () => {
  it('refreshes workspace guidance when a cached child receives another turn', async () => {
    const { cwd, store, parent, runtime } = await fixture();
    const childDir = join(cwd, 'child');
    await mkdir(childDir);
    await writeFile(join(childDir, 'AGENTS.md'), 'WRONG CHILD');
    const model = new FakeModel([textResponse('first'), textResponse('second'), textResponse('third')]);
    const manager = new SubagentManager({ store, runtime, createModel: () => model });
    managers.push(manager);
    const { id } = await manager.start(parent, { description: 'test', prompt: 'first', cwd: childDir });
    await manager.wait(parent, id, 4_000, new AbortController().signal);
    expect(model.requests[0]!.system).not.toContain('WRONG CHILD');
    await writeFile(join(cwd, 'AGENTS.md'), 'ROOT FIRST');
    await manager.send(parent, id, 'second');
    await manager.wait(parent, id, 4_000, new AbortController().signal);
    expect(model.requests[1]!.system).toContain('ROOT FIRST');
    await writeFile(join(cwd, 'AGENTS.md'), 'ROOT SECOND');
    await manager.send(parent, id, 'third');
    await manager.wait(parent, id, 4_000, new AbortController().signal);
    expect(model.requests[2]!.system).toContain('ROOT SECOND');
    expect(model.requests[2]!.system).not.toContain('ROOT FIRST');
  });
  it('starts the requested agent with its profile and persists both selections', async () => {
    const { cwd, store, parentHandle, parent, runtime } = await fixture();
    const childModel = new FakeModel([textResponse('explored')]);
    const manager = new SubagentManager({
      store,
      runtime,
      createModel: () => childModel,
      maxDepth: 2,
      maxActive: 4,
    });
    managers.push(manager);

    const started = await manager.start(parent, {
      description: 'Explore',
      prompt: 'Find the file',
      agent: 'explorer',
    });
    expect(started).toMatchObject({ status: 'running' });
    const outcome = await manager.wait(parent, started.id, 4_000, new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'completed', result: 'explored' });

    const child = await store.open(cwd, started.id);
    expect(child.events).toContainEqual(expect.objectContaining({
      type: 'agent/selected', data: { version: 1, agent: 'explorer' },
    }));
    expect(child.events).toContainEqual(expect.objectContaining({
      type: 'model/selected', data: { version: 2, kind: 'agent' },
    }));
    expect(childModel.requests[0]!.system).toContain('EXPLORER BODY');
    expect(childModel.requests[0]!.tools.map((tool) => tool.name).sort()).toEqual(['read_file']);
    await waitFor(() => parentHandle.events.some((event) => event.type === 'subagent/end'), 'parent settlement');
    expect(parentHandle.events).toContainEqual(expect.objectContaining({
      type: 'subagent/start', data: expect.objectContaining({ id: started.id, agent: 'explorer' }),
    }));
    expect(parentHandle.events).toContainEqual(expect.objectContaining({
      type: 'subagent/end', data: expect.objectContaining({ childId: started.id, status: 'completed', result: 'explored' }),
    }));
    await waitFor(() => parentHandle.events.some((event) => event.type === 'subagent/notice'), 'parent notice');
    expect(await manager.list(parent)).toEqual([
      expect.objectContaining({ kind: 'root', id: 'parent' }),
      expect.objectContaining({
        kind: 'child',
        id: started.id,
        label: 'Explore',
        status: 'inactive',
        parent: 'parent',
        depth: 1,
      }),
    ]);
  });

  it('rejects agents that are not available as subagents', async () => {
    const { store, parent, runtime } = await fixture();
    const manager = new SubagentManager({
      store,
      runtime,
      createModel: () => new FakeModel([]),
      maxDepth: 2,
      maxActive: 4,
    });
    managers.push(manager);
    await expect(manager.start(parent, {
      description: 'Wrong agent',
      prompt: 'Should not start',
      agent: 'primary',
    })).rejects.toThrow(/not available as a subagent/);
    expect((await store.list()).filter((item) => item.parentSessionId === 'parent')).toHaveLength(0);
  });

  it('lazily resumes a persisted child through the runtime and preserves its agent', async () => {
    const { cwd, store, parent, runtime } = await fixture();
    const firstModel = new FakeModel([textResponse('first')]);
    const first = new SubagentManager({
      store, runtime, createModel: () => firstModel, maxDepth: 2, maxActive: 4,
    });
    managers.push(first);
    const { id } = await first.start(parent, { description: 'Explore', prompt: 'first', agent: 'explorer' });
    expect((await first.wait(parent, id, 4_000, new AbortController().signal)).result).toBe('first');
    await first.close();

    const secondModel = new FakeModel([textResponse('second')]);
    const second = new SubagentManager({
      store, runtime, createModel: () => secondModel, maxDepth: 2, maxActive: 4,
    });
    managers.push(second);
    const listed = await second.list(parent);
    expect(listed).toEqual([
      { kind: 'root', id: 'parent', status: 'inactive' },
      {
        kind: 'child',
        id,
        label: 'Explore',
        status: 'inactive',
        parent: 'parent',
        depth: 1,
      },
    ]);

    await second.send(parent, id, 'again');
    expect((await second.wait(parent, id, 4_000, new AbortController().signal)).result).toBe('second');
    expect(secondModel.requests[0]!.system).toContain('EXPLORER BODY');
    expect((await store.open(cwd, id)).events).toContainEqual(expect.objectContaining({
      type: 'agent/selected', data: { version: 1, agent: 'explorer' },
    }));
  });

  it('validates role and explicit model bindings before creating a child', async () => {
    const { store, parent, runtime } = await fixture();
    const manager = new SubagentManager({
      store, runtime, createModel: () => new FakeModel([]), maxDepth: 2, maxActive: 4,
    });
    managers.push(manager);

    await expect(manager.start(parent, {
      description: 'missing role', prompt: 'x', role: 'missing',
    })).rejects.toThrow(/Unknown role/);
    await expect(manager.start(parent, {
      description: 'missing model', prompt: 'x', provider: 'missing', model: 'missing',
    })).rejects.toThrow(/Unknown model/);
    await expect(manager.start(parent, {
      description: 'no route', prompt: 'x', reasoningEffort: 'high',
    })).rejects.toThrow(/requires an explicit provider\/model/);
    await expect(manager.start(parent, {
      description: 'mixed', prompt: 'x', role: 'default', provider: 'missing', model: 'missing',
    })).rejects.toThrow(/cannot be combined/);
    await expect(manager.start(parent, {
      description: 'half route', prompt: 'x', provider: 'missing',
    })).rejects.toThrow(/must be supplied together/);
    expect((await store.list()).filter((item) => item.parentSessionId === 'parent')).toHaveLength(0);
  });

  it('enforces depth, capacity, cwd containment, and interrupts a running child', async () => {
    const slow = (request: ModelRequest): Promise<never> => new Promise((_resolve, reject) => {
      if (request.signal?.aborted) return reject(request.signal.reason);
      request.signal?.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
    });
    const { store, parent, runtime } = await fixture();
    const manager = new SubagentManager({
      store,
      runtime,
      createModel: () => ({ name: 'slow', complete: slow }),
      maxDepth: 1,
      maxActive: 1,
    });
    managers.push(manager);

    const started = await manager.start(parent, { description: 'slow', prompt: 'wait' });
    await expect(manager.start(parent, { description: 'second', prompt: 'wait' })).rejects.toThrow(/capacity/);
    expect(await manager.interrupt(parent, started.id)).toBe(true);
    expect(await manager.wait(parent, started.id, 4_000, new AbortController().signal))
      .toMatchObject({ id: started.id, status: 'interrupted' });
    expect(await manager.interrupt(parent, started.id)).toBe(false);
    await expect(manager.start(parent, { description: 'outside', prompt: 'x', cwd: '../escape' })).rejects.toThrow();

    const shallow = new SubagentManager({
      store, runtime, createModel: () => new FakeModel([]), maxDepth: 0, maxActive: 2,
    });
    managers.push(shallow);
    expect(shallow.canStart(parent)).toBe(false);
    await expect(shallow.start(parent, { description: 'no', prompt: 'no' })).rejects.toThrow(/depth/);
  });

  it('fails closed when a resumed child has no valid model binding', async () => {
    const { cwd, store, parent, runtime } = await fixture();
    const handle = await store.create({ id: 'orphan', workspace: cwd, cwd, parentSessionId: 'parent', depth: 1 });
    await handle.append({ type: 'permission/dsh-preset', data: { version: 1, preset: 'workspace-write' } });
    await handle.append({ type: 'agent/selected', data: { version: 1, agent: 'explorer' } });
    const manager = new SubagentManager({
      store, runtime, createModel: () => new FakeModel([]), maxDepth: 2, maxActive: 4,
    });
    managers.push(manager);
    await expect(manager.send(parent, 'orphan', 'hello')).rejects.toThrow(/no valid model selection/i);
  });
});
