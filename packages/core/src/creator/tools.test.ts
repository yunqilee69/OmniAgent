import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCatalog } from '../agents/catalog';
import { ConfigStore } from '../config/store';
import type { Tool } from '../domain/tool';
import { ModeStore } from '../modes/store';
import type { ModeSummary } from '../modes/store';
import { snapshotDshPermissions } from '../permissions/dsh-permissions';
import { FakeModel, textResponse, toolCallResponse } from '../providers/fake';
import { Session } from '../session';
import {
  CREATOR_MCP_TOOL_GROUP,
  CREATOR_TOOL_GROUP,
  createCreatorTools,
  renderCreatorToolGuidance,
} from './tools';
import type {
  CreatorDiscoveredModel,
  CreatorMcpServerList,
  CreatorMcpServerSummary,
  CreatorMcpServerWrite,
  CreatorModeOptions,
  CreatorModelSourceList,
  CreatorModelSourceSummary,
  CreatorModelSourceWrite,
  CreatorRoleEntry,
  CreatorRoleWrite,
  CreatorServices,
} from './types';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

const ctx = { cwd: '/workspace', signal: new AbortController().signal };

function tool(tools: readonly Tool[], name: string): Tool {
  const found = tools.find((item) => item.name === name);
  if (found === undefined) throw new Error(`missing tool ${name}`);
  return found;
}

async function callJson(tools: readonly Tool[], name: string, args: unknown = {}): Promise<unknown> {
  const output = await tool(tools, name).execute(args, ctx);
  expect(output.ok).not.toBe(false);
  return JSON.parse(output.content) as unknown;
}

const modeSummary = {
  id: 'standard', type: 'single', name: '标准模式', agent: 'default',
  tools: '*', skills: '*',
        mcp: '*', members: [], policy: {}, builtIn: true, customized: false,
  valid: true, warnings: [],
} as unknown as ModeSummary;

const roleEntry: CreatorRoleEntry = {
  id: 'quick', name: 'Quick', provider: 'gateway', model: 'model-a', valid: true,
};

const sourceSummary: CreatorModelSourceSummary = {
  id: 'gateway', name: 'Gateway', api: 'openai-completions',
  apiKeyConfigured: true, apiKeyEnv: 'GATEWAY_KEY', models: [], builtIn: false,
  legacy: false, active: true, removable: true, valid: true,
};

const mcpSummary: CreatorMcpServerSummary = {
  id: 'echo', transport: 'stdio', enabled: true, command: 'npx', args: [],
  envKeys: ['TOKEN'], headerKeys: [], valid: true,
};

function fixture(): CreatorServices {
  return {
    modes: {
      list: vi.fn(async () => [modeSummary]),
      save: vi.fn(async (id: string, input: unknown) => ({ ...modeSummary, ...(input as object), id }) as ModeSummary),
      remove: vi.fn(async () => true),
      defaultId: vi.fn(async () => 'standard'),
      setDefault: vi.fn(async (id: string) => id),
      options: vi.fn(async (): Promise<CreatorModeOptions> => ({ tools: ['read_file'], skills: ['docs'] })),
    },
    roles: {
      list: vi.fn(async () => [roleEntry]),
      save: vi.fn(async (id: string, input: CreatorRoleWrite) => ({ id, ...input, valid: true }) as CreatorRoleEntry),
      remove: vi.fn(async () => true),
    },
    modelSources: {
      list: vi.fn(async (): Promise<CreatorModelSourceList> => ({
        sources: [sourceSummary], defaultSource: 'gateway', defaultModel: 'model-a',
        protocols: ['openai-completions'], catalogProviders: [],
      })),
      save: vi.fn(async (id: string, input: CreatorModelSourceWrite) =>
        ({ ...sourceSummary, ...input, id }) as CreatorModelSourceSummary),
      remove: vi.fn(async () => true),
      discover: vi.fn(async (): Promise<{ models: CreatorDiscoveredModel[] }> => ({ models: [{ id: 'remote' }] })),
    },
    settings: {
      read: vi.fn(async () => ({
        permissions: { defaultPreset: 'workspace-write' as const, requiresSelection: false as const },
        archive: { enabled: false, retentionMs: 86_400_000, requiresSelection: false },
        askUser: { timeoutSec: 300, requiresSelection: false },
        defaultMode: 'standard',
      })),
      updatePermission: vi.fn(async () => ({ defaultPreset: 'read-only' as const, requiresSelection: false as const })),
      updateArchive: vi.fn(async (input: { enabled: boolean; retentionMs: number }) => ({
        ...input, requiresSelection: false,
      })),
      updateAskUser: vi.fn(async (input: { timeoutSec: number }) => ({ ...input, requiresSelection: false })),
    },
    mcp: {
      list: vi.fn(async (): Promise<CreatorMcpServerList> => ({ servers: [mcpSummary], transports: ['stdio', 'http'] })),
      save: vi.fn(async (id: string, input: CreatorMcpServerWrite) =>
        ({ ...mcpSummary, ...input, id }) as CreatorMcpServerSummary),
      remove: vi.fn(async () => true),
      test: vi.fn(async () => ({
        ok: true, transport: 'stdio' as const, durationMs: 1,
        tools: [{ name: 'echo', readOnly: true }], resources: [], prompts: [],
      })),
    },
  };
}

describe('creator configuration tools', () => {
  it('mounts every group and only exposes MCP tools when the host provides them', () => {
    const services = fixture();
    const tools = createCreatorTools(services);
    expect(tools.map((item) => item.name)).toEqual([...CREATOR_TOOL_GROUP]);
    expect(tools).toHaveLength(20);

    const withoutMcp = createCreatorTools({ ...services, mcp: undefined });
    expect(withoutMcp).toHaveLength(16);
    expect(withoutMcp.some((item) => (CREATOR_MCP_TOOL_GROUP as readonly string[]).includes(item.name))).toBe(false);
  });

  it('marks every write as mutating and every read as non-mutating', () => {
    const tools = createCreatorTools(fixture());
    const writes = [
      'write_mode', 'delete_mode', 'set_default_mode',
      'write_model_role', 'delete_model_role',
      'write_model_source', 'delete_model_source',
      'update_permission_default', 'update_archive_settings', 'update_ask_user_timeout',
      'write_mcp_server', 'delete_mcp_server',
    ];
    for (const name of writes) expect(tool(tools, name).mutating, name).toBe(true);

    const reads = [
      'list_modes', 'list_mode_options', 'list_model_roles', 'list_model_sources',
      'discover_models', 'get_omniagent_settings', 'list_mcp_servers', 'test_mcp_server',
    ];
    for (const name of reads) expect(tool(tools, name).mutating, name).toBe(false);
  });

  it('reads and writes mode presets with the versioned model binding', async () => {
    const services = fixture();
    const tools = createCreatorTools(services);

    expect(await callJson(tools, 'list_modes')).toEqual({
      modes: [JSON.parse(JSON.stringify(modeSummary))],
      defaultMode: 'standard',
    });
    expect(await callJson(tools, 'list_mode_options')).toEqual({ tools: ['read_file'], skills: ['docs'] });
    expect(services.modes.options).toHaveBeenCalledWith('/workspace');

    await callJson(tools, 'write_mode', {
      id: 'research',
      name: 'Research',
      agent: 'default',
      tools: ['read_file'],
      skills: [],
      model: { kind: 'role', role: 'quick' },
      policy: { maxActive: 2 },
    });
    expect(services.modes.save).toHaveBeenCalledWith('research', expect.objectContaining({
      type: 'single',
      name: 'Research',
      agent: 'default',
      tools: ['read_file'],
      skills: [],
      model: { version: 2, kind: 'role', role: 'quick' },
      policy: { maxActive: 2 },
    }));

    await callJson(tools, 'write_mode', {
      id: 'team',
      type: 'team',
      name: 'Team',
      agent: 'default',
      model: { kind: 'model', provider: 'gateway', model: 'model-a', reasoningEffort: 'high' },
      members: [{ id: 'reader', name: 'Reader', agent: 'default', model: { kind: 'agent' } }],
    });
    expect(services.modes.save).toHaveBeenLastCalledWith('team', expect.objectContaining({
      type: 'team',
      model: { version: 2, kind: 'model', provider: 'gateway', model: 'model-a', reasoningEffort: 'high' },
      members: [expect.objectContaining({ id: 'reader', model: { version: 2, kind: 'agent' } })],
    }));

    expect(await callJson(tools, 'delete_mode', { id: 'research' })).toEqual({ id: 'research', removed: true });
    expect(await callJson(tools, 'set_default_mode', { id: 'research' })).toEqual({ defaultMode: 'research' });
  });

  it('reads and writes roles without accepting credentials', async () => {
    const services = fixture();
    const tools = createCreatorTools(services);

    expect(await callJson(tools, 'list_model_roles')).toEqual({ roles: [roleEntry] });
    await callJson(tools, 'write_model_role', {
      id: 'quick', name: 'Quick', provider: 'gateway', model: 'model-a', reasoningEffort: 'low',
    });
    expect(services.roles.save).toHaveBeenCalledWith('quick', {
      name: 'Quick', provider: 'gateway', model: 'model-a', reasoningEffort: 'low',
    });
    expect(await callJson(tools, 'delete_model_role', { id: 'quick' })).toEqual({ id: 'quick', removed: true });
  });

  it('writes model sources through apiKeyEnv and refuses a literal key', async () => {
    const services = fixture();
    const tools = createCreatorTools(services);

    await callJson(tools, 'write_model_source', {
      id: 'gateway',
      name: 'Gateway',
      api: 'openai-completions',
      baseURL: 'https://gateway.example/v1',
      apiKeyEnv: 'GATEWAY_KEY',
      maxRetries: 2,
      models: [{ id: 'model-a', input: ['text'], reasoning: false }],
    });
    expect(services.modelSources.save).toHaveBeenCalledWith('gateway', {
      name: 'Gateway',
      api: 'openai-completions',
      baseURL: 'https://gateway.example/v1',
      apiKeyEnv: 'GATEWAY_KEY',
      maxRetries: 2,
      models: [{ id: 'model-a', input: ['text'], reasoning: false }],
    });

    const sourceTool = tool(tools, 'write_model_source');
    await expect(sourceTool.execute({
      id: 'gateway', api: 'openai-completions', baseURL: 'https://gateway.example/v1', apiKey: 'sk-secret',
    }, ctx)).rejects.toThrow();
    await expect(sourceTool.execute({
      id: 'gateway', api: 'openai-completions', unexpected: true,
    }, ctx)).rejects.toThrow();
    expect(services.modelSources.save).toHaveBeenCalledTimes(1);

    expect(await callJson(tools, 'delete_model_source', { id: 'gateway' }))
      .toEqual({ id: 'gateway', removed: true });
    expect(await callJson(tools, 'discover_models', { provider: 'gateway', api: 'openai-completions' }))
      .toEqual({ models: [{ id: 'remote' }] });
    expect(services.modelSources.discover).toHaveBeenCalledWith({ provider: 'gateway', api: 'openai-completions' });
  });

  it('reads and updates the general settings with safe permission presets', async () => {
    const services = fixture();
    const tools = createCreatorTools(services);

    expect(await callJson(tools, 'get_omniagent_settings')).toMatchObject({ defaultMode: 'standard' });
    expect(await callJson(tools, 'update_permission_default', { defaultPreset: 'read-only' }))
      .toEqual({ permissions: { defaultPreset: 'read-only', requiresSelection: false } });
    await expect(tool(tools, 'update_permission_default').execute({ defaultPreset: 'danger-full-access' }, ctx))
      .rejects.toThrow();
    expect(services.settings.updatePermission).toHaveBeenCalledTimes(1);

    expect(await callJson(tools, 'update_archive_settings', { enabled: true, retentionMs: 86_400_000 }))
      .toEqual({ archive: { enabled: true, retentionMs: 86_400_000, requiresSelection: false } });
    expect(await callJson(tools, 'update_ask_user_timeout', { timeoutSec: -1 }))
      .toEqual({ askUser: { timeoutSec: -1, requiresSelection: false } });
    await expect(tool(tools, 'update_ask_user_timeout').execute({ timeoutSec: 0 }, ctx)).rejects.toThrow();
  });

  it('accepts only ${VAR} references for MCP env and headers', async () => {
    const services = fixture();
    const tools = createCreatorTools(services);

    expect(await callJson(tools, 'list_mcp_servers')).toMatchObject({ servers: [{ id: 'echo' }] });
    await callJson(tools, 'write_mcp_server', {
      id: 'echo',
      type: 'stdio',
      command: 'npx',
      env: { TOKEN: '${MCP_TOKEN}', COMBINED: 'Bearer ${MCP_TOKEN}' },
      clearEnv: ['OLD'],
    });
    expect(services.mcp!.save).toHaveBeenCalledWith('echo', {
      type: 'stdio',
      command: 'npx',
      env: { TOKEN: '${MCP_TOKEN}', COMBINED: 'Bearer ${MCP_TOKEN}' },
      clearEnv: ['OLD'],
    });

    const writeTool = tool(tools, 'write_mcp_server');
    for (const value of ['literal-secret', '$MCP_TOKEN', 'Bearer literal-token']) {
      await expect(writeTool.execute({
        id: 'echo', type: 'http', url: 'https://example.com/mcp', headers: { Authorization: value },
      }, ctx)).rejects.toThrow();
    }
    expect(services.mcp!.save).toHaveBeenCalledTimes(1);

    expect(await callJson(tools, 'test_mcp_server', { id: 'echo' }))
      .toMatchObject({ ok: true, tools: [{ name: 'echo' }] });
    expect(await callJson(tools, 'delete_mcp_server', { id: 'echo' })).toEqual({ id: 'echo', removed: true });
  });

  it('turns host failures into ok:false results the model can correct', async () => {
    const services = fixture();
    services.modes.remove = vi.fn(async () => { throw new Error('built-in mode cannot be removed'); });
    const output = await tool(createCreatorTools(services), 'delete_mode').execute({ id: 'standard' }, ctx);
    expect(output.ok).toBe(false);
    expect(JSON.parse(output.content)).toEqual({
      code: 'creator_settings_failed',
      message: 'built-in mode cannot be removed',
    });
  });

  it('publishes guidance that forbids hand edits and credentials', () => {
    expect(renderCreatorToolGuidance()).toContain('Do not hand-edit');
    expect(renderCreatorToolGuidance()).toContain('apiKeyEnv');
  });

  it('registers the tools and guidance only when the host injects the services', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-creator-tools-'));
    roots.push(root);
    const agentsDir = join(root, 'agents');
    await mkdir(agentsDir);
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({
      model: 'deepseek-flash',
      provider: 'deepseek-official',
      agentProfiles: { default: { tools: '*', skills: '*' } },
    }));
    const configStore = await ConfigStore.open(configPath);
    const store = new ModeStore({
      path: join(root, 'modes.json'),
      configStore,
      agents: new AgentCatalog(agentsDir),
    });
    const services = fixture();
    services.modes = {
      list: () => store.list(),
      save: (id, input) => store.save(id, input),
      remove: (id) => store.remove(id),
      defaultId: () => store.defaultId(),
      setDefault: (id) => store.setDefault(id),
      options: async () => ({ tools: ['read_file'], skills: [] }),
    };
    const agent = {
      id: 'creator', name: 'Creator', role: 'default', usage: 'primary' as const,
      tools: '*' as const, skills: '*' as const, mcp: '*' as const,
    };
    const model = new FakeModel([
      toolCallResponse([{
        id: 'call-1',
        name: 'write_mode',
        args: { id: 'research', name: 'Research', agent: 'default', tools: ['read_file'], skills: [] },
      }]),
      textResponse('done'),
    ]);
    const session = new Session({
      cwd: root,
      model,
      dshPermissions: snapshotDshPermissions({ status: 'ready', preset: 'workspace-write' }),
      agent,
      creator: services,
    });
    expect(session.systemPrompt).toContain('Do not hand-edit');
    for await (const _event of session.send('create a research mode')) {
      // Drain the turn so the tool call executes.
    }
    expect(await store.get('research')).toMatchObject({ name: 'Research', agent: 'default' });

    const plain = new Session({
      cwd: root,
      model: new FakeModel([textResponse('done')]),
      dshPermissions: snapshotDshPermissions({ status: 'ready', preset: 'workspace-write' }),
      agent,
    });
    expect(plain.systemPrompt).not.toContain('Do not hand-edit');
  });
});
