import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentCatalog,
  ConfigStore,
  ModeStore,
  RuntimeResolver,
  SessionStore,
  createInitialDshPermissionEvent,
  Session,
  projectAgentSelection,
  projectModeSelection,
  projectModelSelection,
} from '@omniagent/core';
import type { ResolvedSessionRuntime, SessionHandle } from '@omniagent/core';
import { startWebHost } from './server';
import type { WebHost, WebHostOptions, ModelSummary } from './server';
import { WorkspaceRegistry } from './workspaces';
import { RoleSettings } from './catalog-settings';

const hosts: WebHost[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.close())); });

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

const CONFIG = {
  model: 'deepseek-flash',
  provider: 'deepseek-official',
  providers: {
    'deepseek-official': { apiKey: 'test-secret-never-public' },
  },
  roles: {
    quick: {
      name: 'Quick',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'low',
    },
  },
  agentProfiles: {
    default: { tools: '*', skills: '*' },
    search: { tools: ['read_file'], skills: [] },
  },
};

/** Holds a turn open so a test can act while it is running. */
interface TurnHold {
  started: () => void;
  gate: Promise<void>;
}

async function setup(hold?: TurnHold) {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-runtime-route-'));
  const configDir = join(root, 'config');
  const path = join(root, 'workspace');
  await mkdir(configDir);
  await mkdir(path);
  await writeFile(join(configDir, 'config.json'), JSON.stringify(CONFIG));
  await mkdir(join(configDir, 'agents'));
  await writeFile(join(configDir, 'agents', 'writer.md'), [
    '---',
    'name: Writer',
    'description: Writes code',
    'role: quick',
    'usage: primary',
    'profile: default',
    '---',
    'You write code.',
  ].join('\n'));
  await writeFile(join(configDir, 'agents', 'explorer.md'), [
    '---',
    'name: Explorer',
    'description: Searches only',
    'usage: subagent',
    'profile: search',
    '---',
    'You search.',
  ].join('\n'));
  await writeFile(join(configDir, 'agents', 'scout.md'), [
    '---',
    'name: Scout',
    'description: Searches without skills',
    'role: quick',
    'usage: primary',
    'profile: search',
    '---',
    'You search.',
  ].join('\n'));
  await mkdir(join(path, '.agents', 'skills', 'reviewer'), { recursive: true });
  await writeFile(join(path, '.agents', 'skills', 'reviewer', 'SKILL.md'), [
    '---',
    'name: reviewer',
    'description: Reviews code changes',
    '---',
    'Review the diff before approving it.',
  ].join('\n'));
  const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
  const workspace = await workspaces.add(path);
  const store = new SessionStore(join(root, 'sessions'));
  const configStore = await ConfigStore.open(join(configDir, 'config.json'));
  const agents = new AgentCatalog(join(configDir, 'agents'));
  const runtime = new RuntimeResolver({ configStore, agents });
  const modeStore = new ModeStore({ path: join(configDir, 'modes.json'), configStore, agents });
  const roleSettings = await RoleSettings.open(join(configDir, 'config.json'));
  const captured: ResolvedSessionRuntime[] = [];
  const permissionSettings = {
    async read() { return { defaultPreset: 'workspace-write' as const, requiresSelection: false }; },
    async update(value: { defaultPreset: 'workspace-write' }) { return value; },
    snapshot() { return { defaultPreset: 'workspace-write' as const, requiresSelection: false, revision: 0 }; },
    async current() { return this.snapshot(); },
  };
  const host = await startWebHost({
    workspaces,
    store,
    runtime,
    modeStore,
    roleSettings,
    permissionSettings: permissionSettings as unknown as WebHostOptions['permissionSettings'],
    listAgents: async () => {
      const snapshot = await configStore.refresh();
      const catalog = await agents.refresh(snapshot.catalog);
      return catalog.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        role: agent.role,
        usage: agent.usage,
        profile: agent.profile,
        valid: true,
        warnings: [],
      }));
    },
    listRoles: async () => {
      const snapshot = await configStore.refresh();
      return [...snapshot.catalog.roles.values()].map((role) => ({
        id: role.id,
        name: role.name,
        provider: role.provider,
        model: role.model,
        ...(role.reasoningEffort === undefined ? {} : { reasoningEffort: role.reasoningEffort }),
      }));
    },
    modelCatalog: () => {
      const snapshot = configStore.snapshot;
      return [...snapshot.catalog.providers.values()].flat().map((model) => ({
        provider: model.provider,
        model: model.id,
        name: model.name,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        capabilities: model.capabilities,
        reasoningEfforts: model.reasoning ? Object.keys(model.reasoning.efforts) as ModelSummary['reasoningEfforts'] : [],
        ...(model.reasoning?.default === undefined ? {} : { defaultReasoningEffort: model.reasoning.default }),
      }));
    },
    replayContext(workspace, handle, permissions, resolved) {
      if (!resolved.model) return undefined;
      return new Session({ cwd: workspace.path, session: handle, dshPermissions: permissions,
        model: resolved.model, modelId: resolved.modelId, system: resolved.system, agent: resolved.sessionAgent }).contextProjection();
    },
    createRuntimeSession(_workspace, handle, _permissions, resolved) {
      captured.push(resolved);
      return {
        id: handle.id,
        async *send() {
          if (hold === undefined) {
            yield { type: 'turn.end', reason: 'end_turn' };
            return;
          }
          yield { type: 'turn.start', step: 0 };
          hold.started();
          await hold.gate;
          yield { type: 'turn.end', reason: 'end_turn' };
        },
        interrupt() {},
      };
    },
  });
  hosts.push(host);
  const url = `${host.address()}/api/workspaces/${workspace.id}/sessions`;
  return { host, url, workspace, store, configStore, agents, runtime, modeStore, roleSettings, captured, configDir, path };
}

async function create(url: string, body: unknown = {}): Promise<{ sessionUrl: string; id: string }> {
  const response = await fetch(url, post(body));
  expect(response.status).toBe(201);
  const { session } = await response.json() as { session: { id: string; agent?: string } };
  return { sessionUrl: `${url}/${session.id}`, id: session.id };
}

describe('configured session API', () => {
  it('invalidates a cached session when workspace AGENTS.md changes', async () => {
    const { url, path, captured } = await setup();
    const { sessionUrl } = await create(url);
    const send = async () => {
      const response = await fetch(`${sessionUrl}/messages`, post({ text: 'go' }));
      expect(response.status).toBe(200);
      await response.text();
    };
    await send();
    await send();
    expect(captured).toHaveLength(1);
    await writeFile(join(path, 'AGENTS.md'), 'NEW RULE');
    await send();
    expect(captured).toHaveLength(2);
    expect(captured[1]!.revision).not.toBe(captured[0]!.revision);
    await writeFile(join(path, 'AGENTS.md'), 'UPDATED RULE');
    await send();
    expect(captured).toHaveLength(3);
    expect(captured[2]!.revision).not.toBe(captured[1]!.revision);
  });
  it('rebuilds a read-only projection for a replayed session', async () => {
    const { url, store, workspace, captured } = await setup();
    const { sessionUrl, id } = await create(url);
    const handle = await store.open(workspace.path, id);
    await handle.append({ type: 'message/user', data: { text: 'history' } });
    const before = handle.events.length;
    const result = await (await fetch(`${sessionUrl}/context`)).json() as { projection: { source: string; breakdown: { messageTokens: number } }; modelWindow: number };
    expect(result.projection.source).toBe('estimate');
    expect(result.projection.breakdown.messageTokens).toBeGreaterThan(0);
    expect(result.modelWindow).toBe(1_048_576);
    expect((await store.open(workspace.path, id)).events).toHaveLength(before);
    expect(captured).toHaveLength(0);
  });

  it('reports the effective compaction window and its source', async () => {
    const { url, configDir } = await setup();
    const { sessionUrl } = await create(url);
    const model = await (await fetch(`${sessionUrl}/context`)).json() as { estimatedMessageTokens: number; window: unknown };
    expect(model.estimatedMessageTokens).toBe(0);
    expect(model.window).toEqual({ tokens: 1_048_576, source: 'model' });
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ ...CONFIG, contextWindowTokens: 1234 }));
    const configured = await (await fetch(`${sessionUrl}/context`)).json() as { window: unknown };
    expect(configured.window).toEqual({ tokens: 1234, source: 'config' });
  });

  it('exposes agents, roles, and credential-free model capabilities', async () => {
    const { host } = await setup();
    const base = host.address()!;
    const agents = await (await fetch(`${base}/api/agents`)).json() as { agents: Array<{ id: string; usage: string }> };
    expect(agents.agents).toContainEqual(expect.objectContaining({ id: 'explorer', usage: 'subagent' }));
    expect(agents.agents).toContainEqual(expect.objectContaining({ id: 'default' }));

    const roles = await (await fetch(`${base}/api/roles`)).json() as { roles: Array<{ id: string }> };
    expect(roles.roles.map((role) => role.id).sort()).toEqual(['default', 'quick']);

    const models = await (await fetch(`${base}/api/models`)).json() as { models: unknown[] };
    expect(JSON.stringify(models)).not.toContain('test-secret-never-public');
    expect(models.models).toContainEqual(expect.objectContaining({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      capabilities: { imageInput: true },
      reasoningEfforts: ['off', 'low', 'high', 'max'],
    }));
    expect(models.models).toContainEqual(expect.objectContaining({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      capabilities: { imageInput: false },
    }));
  });

  it('pins the default agent and model binding and resolves the agent role', async () => {
    const { url, store, workspace, captured } = await setup();
    const { sessionUrl, id } = await create(url);

    const events = (await store.open(workspace.path, id)).events;
    expect(projectAgentSelection(events)).toEqual({ status: 'selected', agent: 'default' });
    expect(projectModelSelection(events)).toEqual({
      status: 'selected',
      binding: { version: 2, kind: 'agent' },
    });

    const detail = await (await fetch(sessionUrl)).json() as {
      agent: { id: string; role: string } | null;
      model: unknown;
      resolvedModel: { model: string; reasoningEffort?: string } | null;
      agentError: string | null;
    };
    expect(detail.agent).toMatchObject({ id: 'default', role: 'default' });
    expect(detail.model).toEqual({ version: 2, kind: 'agent' });
    expect(detail.resolvedModel).toMatchObject({ model: 'deepseek-flash', reasoningEffort: 'high' });
    expect(detail.agentError).toBeNull();

    expect((await fetch(`${sessionUrl}/messages`, post({ text: 'go' }))).status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.agent.id).toBe('default');
    expect(captured[0]!.modelId).toBe('deepseek-flash');
  });

  it('creates sessions with an explicit agent and role binding', async () => {
    const { url } = await setup();
    const { sessionUrl } = await create(url, {
      agent: 'writer',
      model: { version: 2, kind: 'role', role: 'quick' },
    });
    const detail = await (await fetch(sessionUrl)).json() as {
      agent: { id: string };
      resolvedModel: { model: string; reasoningEffort?: string };
    };
    expect(detail.agent.id).toBe('writer');
    expect(detail.resolvedModel).toMatchObject({ model: 'deepseek-v4-pro', reasoningEffort: 'low' });
  });

  it('switches the model while a turn is running and applies it to the next turn', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = new Promise<void>((resolve) => { started = resolve; });
    const { url, store, workspace, captured } = await setup({ started: () => { started(); }, gate });
    const { sessionUrl, id } = await create(url);

    const response = await fetch(`${sessionUrl}/messages`, post({ text: 'go' }));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('turn.start');
      await running;

      const binding = { version: 2, kind: 'role', role: 'quick' } as const;
      const switched = await fetch(`${sessionUrl}/model`, post(binding));
      expect(switched.status).toBe(200);
      expect(await switched.json()).toEqual({
        model: binding,
        resolvedModel: expect.objectContaining({ model: 'deepseek-v4-pro', reasoningEffort: 'low' }),
      });
      // The running turn keeps the runtime it captured at admission.
      expect(captured).toHaveLength(1);
      expect(captured[0]!.modelId).toBe('deepseek-flash');
      expect(projectModelSelection((await store.open(workspace.path, id)).events))
        .toEqual({ status: 'selected', binding });
    } finally {
      release();
      while (!(await reader.read()).done) { /* drain the rest of the turn */ }
    }
    expect(captured).toHaveLength(1);

    const next = await fetch(`${sessionUrl}/messages`, post({ text: 'again' }));
    expect(next.status).toBe(200);
    await next.text();
    expect(captured).toHaveLength(2);
    expect(captured[1]!.modelId).toBe('deepseek-v4-pro');
  });

  it('rejects malformed creation bodies, subagent-only agents, and unknown models', async () => {
    const { url } = await setup();
    expect((await fetch(url, post({ extra: true }))).status).toBe(400);
    expect((await fetch(url, post({ agent: 3 }))).status).toBe(400);
    expect((await fetch(url, post({ model: { version: 1, provider: 'deepseek-official', model: 'deepseek-flash' } }))).status).toBe(400);
    expect((await fetch(url, post({ agent: 'explorer' }))).status).toBe(409);
    expect((await fetch(url, post({ model: { version: 2, kind: 'role', role: 'missing' } }))).status).toBe(409);
    expect((await fetch(url, post({ model: { version: 2, kind: 'model', provider: 'deepseek-official', model: 'missing' } }))).status).toBe(409);
  });

  it('persists agent and model switches and rejects subagent-only agents as root', async () => {
    const { url, store, workspace } = await setup();
    const { sessionUrl, id } = await create(url);

    expect((await fetch(`${sessionUrl}/agent`, post({ agent: 'explorer' }))).status).toBe(409);
    const switchedAgent = await fetch(`${sessionUrl}/agent`, post({ agent: 'writer' }));
    expect(switchedAgent.status).toBe(200);
    expect(await switchedAgent.json()).toEqual({
      agent: expect.objectContaining({ id: 'writer', role: 'quick', usage: 'primary', profile: 'default' }),
    });

    const switchedModel = await fetch(`${sessionUrl}/model`, post({
      version: 2,
      kind: 'model',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    }));
    expect(switchedModel.status).toBe(200);
    expect(await switchedModel.json()).toEqual({
      model: { version: 2, kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
      resolvedModel: expect.objectContaining({ model: 'deepseek-flash', reasoningEffort: 'high' }),
    });

    const events = (await store.open(workspace.path, id)).events;
    expect(projectAgentSelection(events)).toEqual({ status: 'selected', agent: 'writer' });
    expect(projectModelSelection(events)).toEqual({
      status: 'selected',
      binding: { version: 2, kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
    });
    expect((await fetch(`${sessionUrl}/model`, post({ version: 1, provider: 'x', model: 'y' }))).status).toBe(400);
  });

  it('requires explicit agent and model selection for legacy sessions', async () => {
    const { url, store, workspace } = await setup();
    const legacy = await store.create({ id: 'legacy', workspace: workspace.path, cwd: workspace.path });
    await legacy.append(createInitialDshPermissionEvent('workspace-write'));
    const sessionUrl = `${url}/legacy`;

    const detail = await (await fetch(sessionUrl)).json() as { agent: unknown; model: unknown; agentError: string | null };
    expect(detail.agent).toBeNull();
    expect(detail.model).toBeNull();
    expect(detail.agentError).toMatch(/agent must be selected/i);
    expect((await fetch(`${sessionUrl}/messages`, post({ text: 'go' }))).status).toBe(409);

    expect((await fetch(`${sessionUrl}/model`, post({ version: 2, kind: 'agent' }))).status).toBe(409);
    expect((await fetch(`${sessionUrl}/agent`, post({ agent: 'default' }))).status).toBe(200);
    expect((await fetch(`${sessionUrl}/model`, post({ version: 2, kind: 'agent' }))).status).toBe(200);
    expect((await fetch(`${sessionUrl}/messages`, post({ text: 'go' }))).status).toBe(200);
  });

  it('reloads config and agent files for the next turn', async () => {
    const { url, configStore, runtime, configDir, captured } = await setup();
    const { sessionUrl } = await create(url, { agent: 'writer' });

    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      ...CONFIG,
      roles: {
        quick: {
          name: 'Quick',
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          reasoningEffort: 'max',
        },
      },
    }));
    await configStore.refresh();
    const resolved = await runtime.resolve({
      cwd: process.cwd(),
      agentId: 'writer',
      binding: { version: 2, kind: 'agent' },
      isRoot: true,
    });
    expect(resolved.modelId).toBe('deepseek-flash');

    expect((await fetch(`${sessionUrl}/messages`, post({ text: 'go' }))).status).toBe(200);
    expect(captured.at(-1)!.modelId).toBe('deepseek-flash');
    expect(captured.at(-1)!.reasoningEffort).toBe('max');
  });

  it('lists and persists mode presets through the settings routes', async () => {
    const { host } = await setup();
    const base = host.address()!;
    const initial = await (await fetch(`${base}/api/modes`)).json() as {
      modes: Array<{ id: string; valid: boolean }>;
      defaultMode: string;
    };
    expect(initial.modes.map((mode) => mode.id)).toEqual(['standard', 'creator']);
    expect(initial.defaultMode).toBe('standard');

    const saved = await fetch(`${base}/api/modes/writer-mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Writer mode',
        description: 'Writer with the quick role.',
        agent: 'writer',
        model: { version: 2, kind: 'role', role: 'quick' },
        tools: ['read_file'],
        skills: ['docs'],
      }),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json() as { mode: { id: string } }).mode.id).toBe('writer-mode');

    const defaulted = await fetch(`${base}/api/settings/default-mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'writer-mode' }),
    });
    expect(await defaulted.json()).toEqual({ defaultMode: 'writer-mode' });
    expect((await fetch(`${base}/api/settings/default-mode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'missing' }),
    })).status).toBe(400);

    const removed = await fetch(`${base}/api/modes/writer-mode`, { method: 'DELETE' });
    expect(await removed.json()).toEqual({ removed: true });
    const after = await (await fetch(`${base}/api/modes`)).json() as { defaultMode: string };
    expect(after.defaultMode).toBe('standard');
  });

  it('exposes tools and discovered skills for the mode editor', async () => {
    const { host, workspace } = await setup();
    const response = await fetch(`${host.address()}/api/modes/options?workspaceId=${encodeURIComponent(workspace.id)}`);
    expect(response.status).toBe(200);
    const options = await response.json() as { tools: string[]; skills: Array<{ name: string }> };
    expect(options.tools).toContain('read_file');
    expect(options.tools).toContain('subagent');
    expect(Array.isArray(options.skills)).toBe(true);
    expect((await fetch(`${host.address()}/api/modes/options?workspaceId=missing`)).status).toBe(404);
  });

  it('reports only the skills the current session agent may load', async () => {
    const { url } = await setup();
    const writer = await create(url);
    const writerDetail = await (await fetch(writer.sessionUrl)).json() as {
      agentSkills: Array<{ name: string; description: string }>;
    };
    expect(writerDetail.agentSkills).toContainEqual({ name: 'reviewer', description: 'Reviews code changes' });

    const scout = await create(url, { agent: 'scout' });
    const scoutDetail = await (await fetch(scout.sessionUrl)).json() as {
      agentSkills: Array<{ name: string; description: string }>;
    };
    expect(scoutDetail.agentSkills).toEqual([]);
  });

  it('creates a session from a mode snapshot with a fixed agent and switchable model', async () => {
    const { url, store, workspace, captured } = await setup();
    const response = await fetch(url, post({ mode: 'creator' }));
    expect(response.status).toBe(201);
    const { session } = await response.json() as { session: { id: string; mode?: string } };
    expect(session.mode).toBe('creator');
    const sessionUrl = `${url}/${session.id}`;

    const events = (await store.open(workspace.path, session.id)).events;
    expect(projectAgentSelection(events)).toEqual({ status: 'selected', agent: 'creator' });
    const mode = projectModeSelection(events);
    expect(mode.status).toBe('selected');
    if (mode.status !== 'selected') throw new Error('mode selection missing');
    expect(mode.selection).toMatchObject({
      mode: 'creator',
      agent: 'creator',
      model: { version: 2, kind: 'agent' },
    });
    expect(mode.selection.tools).not.toBe('*');
    expect(mode.selection.tools).not.toContain('write_file');
    expect(mode.selection.skills).toBe('*');

    const detail = await (await fetch(sessionUrl)).json() as { mode: unknown };
    expect(detail.mode).toEqual(mode.selection);

    expect((await fetch(`${sessionUrl}/agent`, post({ agent: 'writer' }))).status).toBe(409);
    const switched = await fetch(`${sessionUrl}/model`, post({ version: 2, kind: 'role', role: 'quick' }));
    expect(switched.status).toBe(200);
    expect((await switched.json() as { resolvedModel: { model: string; reasoningEffort?: string } }).resolvedModel)
      .toMatchObject({ model: 'deepseek-v4-pro', reasoningEffort: 'low' });
    expect(projectModelSelection((await store.open(workspace.path, session.id)).events))
      .toMatchObject({ status: 'selected', binding: { version: 2, kind: 'role', role: 'quick' } });

    const completed = await fetch(`${sessionUrl}/messages`, post({ text: 'go' }));
    expect(completed.status).toBe(200);
    await completed.text();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.agent.id).toBe('creator');
    expect(captured[0]!.sessionAgent.tools).not.toBe('*');
    expect(captured[0]!.sessionAgent.tools).not.toContain('write_file');
    expect(captured[0]!.modelId).toBe('deepseek-v4-pro');
  });

  it('creates a mode session with a model override while keeping the mode agent and tools', async () => {
    const { url, store, workspace, captured } = await setup();
    const binding = { version: 2, kind: 'role', role: 'quick' };
    const response = await fetch(url, post({ mode: 'creator', model: binding }));
    expect(response.status).toBe(201);
    const { session } = await response.json() as { session: { id: string; mode?: string } };
    expect(session.mode).toBe('creator');
    const sessionUrl = `${url}/${session.id}`;

    const events = (await store.open(workspace.path, session.id)).events;
    expect(projectAgentSelection(events)).toEqual({ status: 'selected', agent: 'creator' });
    const mode = projectModeSelection(events);
    expect(mode.status).toBe('selected');
    if (mode.status !== 'selected') throw new Error('mode selection missing');
    expect(mode.selection).toMatchObject({ mode: 'creator', agent: 'creator', model: binding });
    expect(mode.selection.tools).not.toBe('*');
    expect(mode.selection.tools).not.toContain('write_file');

    const detail = await (await fetch(sessionUrl)).json() as {
      model: unknown;
      resolvedModel: { model: string; reasoningEffort?: string };
    };
    expect(detail.model).toEqual(binding);
    expect(detail.resolvedModel).toMatchObject({ model: 'deepseek-v4-pro', reasoningEffort: 'low' });

    const completed = await fetch(`${sessionUrl}/messages`, post({ text: 'go' }));
    expect(completed.status).toBe(200);
    await completed.text();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.agent.id).toBe('creator');
    expect(captured[0]!.modelId).toBe('deepseek-v4-pro');
  });

  it('rejects mixed mode and agent overrides and unknown modes', async () => {
    const { url } = await setup();
    expect((await fetch(url, post({ mode: 'creator', agent: 'writer' }))).status).toBe(400);
    expect((await fetch(url, post({ mode: 'creator', model: { version: 1, provider: 'x', model: 'y' } }))).status).toBe(400);
    expect((await fetch(url, post({ mode: 'missing' }))).status).toBe(409);
    expect((await fetch(url, post({ mode: 3 }))).status).toBe(400);
  });

  it('lists, saves and removes roles through the settings routes', async () => {
    const { host } = await setup();
    const base = host.address()!;
    const initial = await (await fetch(`${base}/api/settings/roles`)).json() as {
      roles: Array<{ id: string; builtIn?: boolean; valid: boolean }>;
    };
    expect(initial.roles.find((role) => role.id === 'default')).toMatchObject({ builtIn: true, valid: true });

    const saved = await fetch(`${base}/api/settings/roles/research`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Research', provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json() as { role: { id: string; name: string } }).role).toMatchObject({
      id: 'research', name: 'Research',
    });

    expect((await fetch(`${base}/api/settings/roles/broken`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'missing', model: 'missing' }),
    })).status).toBe(400);
    expect((await fetch(`${base}/api/settings/roles/broken2`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek-official', model: 'deepseek-flash', extra: true }),
    })).status).toBe(400);

    expect(await (await fetch(`${base}/api/settings/roles/research`, { method: 'DELETE' })).json())
      .toEqual({ removed: true });
  });
});
