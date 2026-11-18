import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCatalog, ConfigStore, ModeStore } from '@omniagent/core';
import type { McpProbeResult, McpServerConfig } from '@omniagent/core';
import { ArchiveConfigSettings } from './archive-settings';
import { AskUserConfigSettings } from './ask-user-settings';
import { RoleSettings } from './catalog-settings';
import { createCreatorServices } from './creator-settings';
import { McpSettings } from './mcp-settings';
import { ModelSettings } from './model-settings';
import { PermissionSettings } from './permissions';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

const baseConfig = {
  provider: 'gateway',
  model: 'model-a',
  providers: {
    gateway: {
      api: 'openai-completions',
      baseURL: 'https://gateway.example/v1',
      apiKey: 'sk-secret',
      apiKeyEnv: 'GATEWAY_KEY',
      models: [{ id: 'model-a' }, { id: 'model-b' }],
    },
  },
  roles: {
    default: { provider: 'gateway', model: 'model-a' },
  },
  agentProfiles: {
    default: { tools: '*', skills: '*' },
  },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-creator-settings-'));
  roots.push(root);
  const agentsDir = join(root, 'agents');
  await mkdir(agentsDir);
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(baseConfig));

  const configStore = await ConfigStore.open(path);
  const modes = new ModeStore({
    path: join(root, 'modes.json'),
    configStore,
    agents: new AgentCatalog(agentsDir),
  });
  const permissions = await PermissionSettings.open(path);
  const askUser = await AskUserConfigSettings.open(permissions);
  const archive = await ArchiveConfigSettings.open(permissions);
  const roles = await RoleSettings.open(path);
  const modelSources = await ModelSettings.open(path);
  const probes: McpServerConfig[] = [];
  const mcp = await McpSettings.open(path, {
    probe: async (server): Promise<McpProbeResult> => {
      probes.push(server);
      return {
        ok: true,
        transport: server.transport,
        durationMs: 1,
        tools: [{ name: 'echo', readOnly: true }],
        resources: [],
        prompts: [],
      };
    },
  });
  const services = createCreatorServices({
    modes,
    roles,
    modelSources,
    permissions,
    askUser,
    archive,
    mcp,
    mcpToolNames: () => ['mcp__echo__echo'],
  });
  return { root, path, modes, mcp, probes, services };
}

async function storedConfig(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

describe('createCreatorServices', () => {
  it('creates a mode and lists the tools the workspace accepts', async () => {
    const { root, services } = await fixture();

    const saved = await services.modes.save('focus', {
      name: 'Focus',
      agent: 'default',
      tools: ['read_file'],
      skills: [],
    });
    expect(saved).toMatchObject({ id: 'focus', name: 'Focus', valid: true });
    expect((await services.modes.list()).some((mode) => mode.id === 'focus')).toBe(true);

    const options = await services.modes.options(root);
    expect(options.tools).toContain('read_file');
    expect(options.tools).toContain('mcp__echo__echo');
  });

  it('saves roles and model sources without returning stored credentials', async () => {
    const { services } = await fixture();

    const role = await services.roles.save('quick', { provider: 'gateway', model: 'model-b' });
    expect(role).toMatchObject({ id: 'quick', provider: 'gateway', model: 'model-b', valid: true });

    const list = await services.modelSources.list();
    expect(list.sources[0]).toMatchObject({ id: 'gateway', apiKeyConfigured: true });
    expect(JSON.stringify(list)).not.toContain('sk-secret');

    const source = await services.modelSources.save('gateway', {
      name: 'Renamed Gateway',
      apiKeyEnv: 'NEW_GATEWAY_KEY',
    });
    expect(source).toMatchObject({ id: 'gateway', name: 'Renamed Gateway', apiKeyConfigured: true, valid: true });
    expect(source).not.toHaveProperty('apiKey');
    expect(JSON.stringify(source)).not.toContain('sk-secret');
  });

  it('keeps role, permission, archive and ask-user writes coherent on one config file', async () => {
    const { path, services } = await fixture();

    await services.roles.save('quick', { provider: 'gateway', model: 'model-b' });
    await services.settings.updatePermission({ defaultPreset: 'read-only' });
    await services.settings.updateArchive({ enabled: true, retentionMs: 7_200_000 });
    await services.settings.updateAskUser({ timeoutSec: -1 });

    const config = await storedConfig(path);
    expect((config.roles as Record<string, unknown>).quick)
      .toMatchObject({ provider: 'gateway', model: 'model-b' });
    expect(config.dsh).toMatchObject({ permission: { defaultPreset: 'read-only' } });
    expect(config.archive).toMatchObject({ enabled: true, retentionMs: 7_200_000 });
    expect(config.askUser).toMatchObject({ timeoutSec: -1 });
    expect((config.providers as Record<string, unknown>).gateway).toBeDefined();

    const settings = await services.settings.read();
    expect(settings).toMatchObject({
      permissions: { defaultPreset: 'read-only' },
      archive: { enabled: true, retentionMs: 7_200_000 },
      askUser: { timeoutSec: -1 },
      defaultMode: 'standard',
    });
  });

  it('stores MCP references without exposing the expanded value', async () => {
    const { probes, services } = await fixture();
    expect(services.mcp).toBeDefined();

    const saved = await services.mcp!.save('echo', {
      type: 'stdio',
      command: 'npx',
      env: { TOKEN: '${MCP_TOKEN}' },
    });
    expect(saved).toMatchObject({ id: 'echo', transport: 'stdio', envKeys: ['TOKEN'], valid: true });

    const list = await services.mcp!.list();
    expect(JSON.stringify(list)).not.toContain('${MCP_TOKEN}');
    const probe = await services.mcp!.test('echo');
    expect(probe.ok).toBe(true);
    expect(probes[0]?.env).toEqual({ TOKEN: '${MCP_TOKEN}' });
    expect(await services.mcp!.remove('echo')).toBe(true);
  });
});
