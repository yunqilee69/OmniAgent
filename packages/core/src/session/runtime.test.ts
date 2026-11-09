import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCatalog } from '../agents';
import { ConfigStore } from '../config/store';
import { RuntimeResolver } from './runtime';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-runtime-'));
  roots.push(root);
  const configDir = join(root, 'config');
  const workspace = join(root, 'workspace');
  await mkdir(join(configDir, 'agents'), { recursive: true });
  await mkdir(join(workspace, '.agents', 'skills', 'allowed-skill'), { recursive: true });
  await mkdir(join(workspace, '.agents', 'skills', 'denied-skill'), { recursive: true });
  await writeFile(join(workspace, '.agents', 'skills', 'allowed-skill', 'SKILL.md'), '---\ndescription: Allowed skill\n---\nAllowed body');
  await writeFile(join(workspace, '.agents', 'skills', 'denied-skill', 'SKILL.md'), '---\ndescription: Denied skill\n---\nDenied body');
  await writeFile(join(configDir, 'config.json'), JSON.stringify({
    model: 'deepseek-flash',
    provider: 'deepseek-official',
    providers: { 'deepseek-official': { apiKey: 'SECRET' } },
    roles: { quick: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'low' } },
    agentProfiles: {
      default: { tools: '*', skills: '*' },
      search: { tools: ['read_file', 'skill', 'subagent'], skills: ['allowed-skill'] },
    },
    contextWindowTokens: 1234,
    todo: { allowParallelInProgress: true },
    system: 'GLOBAL',
  }));
  await writeFile(join(configDir, 'agents', 'default.md'), '---\nname: Root Default\n---\nDEFAULT BODY');
  await writeFile(join(configDir, 'agents', 'explorer.md'), [
    '---',
    'name: Explorer',
    'description: Searches',
    'role: quick',
    'usage: subagent',
    'profile: search',
    '---',
    'EXPLORER BODY',
  ].join('\n'));
  const configStore = await ConfigStore.open(join(configDir, 'config.json'));
  const agents = new AgentCatalog(join(configDir, 'agents'));
  const runtime = new RuntimeResolver({ configStore, agents });
  return { root, configDir, workspace, configStore, agents, runtime };
}

describe('RuntimeResolver', () => {
  it('resolves the default agent, model, capabilities, and system prompt', async () => {
    const { runtime, workspace } = await fixture();
    const resolved = await runtime.resolve({
      cwd: workspace,
      agentId: 'default',
      binding: { version: 2, kind: 'agent' },
      isRoot: true,
    });
    expect(resolved.agent).toMatchObject({ id: 'default', name: 'Root Default', usage: 'both' });
    expect(resolved.sessionAgent.tools).toBe('*');
    expect(resolved.sessionAgent.skills).toBe('*');
    expect(resolved.modelId).toBe('deepseek-flash');
    expect(resolved.reasoningEffort).toBe('high');
    expect(resolved.capabilities).toEqual({ imageInput: true });
    expect(resolved.todoAllowParallelInProgress).toBe(true);
    expect(resolved.contextWindowTokens).toBe(1234);
    expect(resolved.contextWindowSource).toBe('config');
    expect(resolved.system).toContain('GLOBAL');
    expect(resolved.system).toContain('DEFAULT BODY');
    expect(resolved.system).toContain('allowed-skill');
    expect(resolved.system).toContain('<available_agents>');
    expect(resolved.system).toContain('explorer');
    expect(resolved.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reports the model window when no context budget is configured', async () => {
    const { runtime, workspace, configDir } = await fixture();
    const config = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'));
    delete config.contextWindowTokens;
    await writeFile(join(configDir, 'config.json'), JSON.stringify(config));
    const resolved = await runtime.resolve({ cwd: workspace, agentId: 'default', isRoot: true });
    expect(resolved.contextWindowTokens).toBe(resolved.modelDescriptor?.contextWindow);
    expect(resolved.contextWindowSource).toBe('model');
  });

  it('defaults parallel todos off when the policy is unconfigured', async () => {
    const { runtime, workspace, configDir } = await fixture();
    const config = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'));
    delete config.todo;
    await writeFile(join(configDir, 'config.json'), JSON.stringify(config));
    const resolved = await runtime.resolve({
      cwd: workspace, agentId: 'default', binding: { version: 2, kind: 'agent' }, isRoot: true,
    });
    expect(resolved.todoAllowParallelInProgress).toBe(false);
  });

  it('enforces agent usage and applies tool/skill profiles for subagents', async () => {
    const { runtime, workspace } = await fixture();
    await expect(runtime.resolve({
      cwd: workspace,
      agentId: 'explorer',
      binding: { version: 2, kind: 'agent' },
      isRoot: true,
    })).rejects.toThrow(/not available as a main agent/);

    const resolved = await runtime.resolve({
      cwd: workspace,
      agentId: 'explorer',
      binding: { version: 2, kind: 'agent' },
      isRoot: false,
    });
    expect(resolved.modelId).toBe('deepseek-v4-pro');
    expect(resolved.reasoningEffort).toBe('low');
    expect([...resolved.sessionAgent.tools as ReadonlySet<string>].sort())
      .toEqual(['interrupt_agent', 'list_agents', 'read_file', 'send_message', 'skill', 'subagent', 'wait_agent']);
    expect([...resolved.sessionAgent.skills as ReadonlySet<string>]).toEqual(['allowed-skill']);
    expect(resolved.system).toContain('EXPLORER BODY');
    expect(resolved.system).toContain('allowed-skill');
    expect(resolved.system).not.toContain('denied-skill');
  });

  it('resolves explicit role and model bindings against the current catalog', async () => {
    const { runtime, workspace } = await fixture();
    const role = await runtime.resolve({
      cwd: workspace,
      agentId: 'default',
      binding: { version: 2, kind: 'role', role: 'quick' },
      isRoot: true,
    });
    expect(role.modelId).toBe('deepseek-v4-pro');
    expect(role.reasoningEffort).toBe('low');

    const explicit = await runtime.resolve({
      cwd: workspace,
      agentId: 'default',
      binding: { version: 2, kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
      isRoot: true,
    });
    expect(explicit.modelId).toBe('deepseek-flash');
    expect(explicit.reasoningEffort).toBe('max');

    await expect(runtime.resolve({
      cwd: workspace,
      agentId: 'default',
      binding: { version: 2, kind: 'role', role: 'missing' },
      isRoot: true,
    })).rejects.toThrow(/unknown role/i);
  });

  it('warns about unavailable skills without granting them', async () => {
    const { runtime, workspace, configDir, configStore } = await fixture();
    await writeFile(join(configDir, 'agents', 'missing-skill.md'), '---\nprofile: missing\n---\n');
    const config = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'));
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      ...config,
      agentProfiles: {
        ...config.agentProfiles,
        missing: { tools: ['skill'], skills: ['absent-skill'] },
      },
    }));
    await configStore.refresh();
    const resolved = await runtime.resolve({
      cwd: workspace,
      agentId: 'missing-skill',
      binding: { version: 2, kind: 'agent' },
      isRoot: true,
    });
    expect(resolved.warnings).toContain('Skill "absent-skill" is not present in this workspace');
    expect([...resolved.sessionAgent.skills as ReadonlySet<string>]).toEqual(['absent-skill']);
    expect(resolved.system).not.toContain('denied-skill');
  });

  it('changes its revision when config or agent content changes', async () => {
    const { runtime, workspace, configDir, agents } = await fixture();
    const first = await runtime.resolve({
      cwd: workspace, agentId: 'default', binding: { version: 2, kind: 'agent' }, isRoot: true,
    });
    await writeFile(join(configDir, 'agents', 'default.md'), '---\nname: Root Default\n---\nDEFAULT BODY CHANGED');
    await agents.refresh();
    const second = await runtime.resolve({
      cwd: workspace, agentId: 'default', binding: { version: 2, kind: 'agent' }, isRoot: true,
    });
    expect(second.revision).not.toBe(first.revision);
    expect(second.system).toContain('DEFAULT BODY CHANGED');

    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      model: 'deepseek-flash',
      provider: 'deepseek-official',
      providers: { 'deepseek-official': { apiKey: 'SECRET' } },
      agentProfiles: { default: { tools: '*', skills: '*' } },
      system: 'CHANGED',
    }));
    const third = await runtime.resolve({
      cwd: workspace, agentId: 'default', binding: { version: 2, kind: 'agent' }, isRoot: true,
    });
    expect(third.revision).not.toBe(second.revision);
    expect(third.system).toContain('CHANGED');
  });
});
