import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCatalog } from '../agents/catalog';
import { ConfigStore } from '../config/store';
import { ModeConfigError, ModeStore } from './store';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-modes-'));
  roots.push(root);
  const agentsDir = join(root, 'agents');
  await mkdir(agentsDir);
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({
    model: 'deepseek-flash',
    provider: 'deepseek-official',
    roles: { quick: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
    agentProfiles: { default: { tools: '*', skills: '*' } },
  }));
  const configStore = await ConfigStore.open(configPath);
  const modesPath = join(root, 'modes.json');
  return {
    root,
    modesPath,
    store: new ModeStore({
      path: modesPath,
      configStore,
      agents: new AgentCatalog(agentsDir),
    }),
  };
}

describe('ModeStore', () => {
  it('lists the two built-in modes in order with the standard mode as default', async () => {
    const { store } = await fixture();
    const modes = await store.list();
    expect(modes.map((mode) => mode.id)).toEqual(['standard', 'creator']);
    expect(modes[0]).toMatchObject({
      name: '标准模式', agent: 'default', builtIn: true, customized: false, valid: true,
    });
    expect(modes[1]).toMatchObject({
      name: '创造模式', agent: 'creator', builtIn: true, customized: false, valid: true,
    });
    expect(await store.defaultId()).toBe('standard');
  });

  it('saves a custom mode and resolves it later', async () => {
    const { store, modesPath } = await fixture();
    const saved = await store.save('research', {
      name: 'Research',
      description: 'Read-only research.',
      agent: 'default',
      tools: ['read_file', 'grep'],
      skills: ['docs'],
    });
    expect(saved).toMatchObject({
      id: 'research', name: 'Research', description: 'Read-only research.',
      agent: 'default', tools: ['read_file', 'grep'], skills: ['docs'],
      builtIn: false, customized: true, valid: true,
    });
    expect((await store.get('research'))?.name).toBe('Research');
    const file = JSON.parse(await readFile(modesPath, 'utf8')) as { version: number; modes: Record<string, unknown> };
    expect(file.version).toBe(1);
    expect(file.modes.research).toMatchObject({ name: 'Research', agent: 'default' });
  });

  it('rejects an invalid mode before writing it to disk', async () => {
    const { store, modesPath } = await fixture();
    await expect(store.save('broken', { name: 'Broken', agent: 'missing' }))
      .rejects.toBeInstanceOf(ModeConfigError);
    await expect(access(modesPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.list()).some((mode) => mode.id === 'broken')).toBe(false);
  });

  it('rejects unknown tools without disturbing an existing modes file', async () => {
    const { store, modesPath } = await fixture();
    await store.save('safe', { name: 'Safe', agent: 'default' });
    const before = await readFile(modesPath, 'utf8');
    await expect(store.save('unsafe', { name: 'Unsafe', agent: 'default', tools: ['not_a_tool'] }))
      .rejects.toThrow(/Unknown tool/);
    expect(await readFile(modesPath, 'utf8')).toBe(before);
    expect((await store.list()).some((mode) => mode.id === 'unsafe')).toBe(false);
  });

  it('supports overriding a built-in mode and restoring it on remove', async () => {
    const { store } = await fixture();
    const customized = await store.save('standard', {
      name: '自定义标准',
      agent: 'default',
      model: { version: 2, kind: 'role', role: 'quick' },
    });
    expect(customized).toMatchObject({ id: 'standard', name: '自定义标准', builtIn: true, customized: true });
    expect(customized.model).toEqual({ version: 2, kind: 'role', role: 'quick' });

    expect(await store.remove('standard')).toBe(true);
    expect(await store.get('standard')).toMatchObject({ name: '标准模式', builtIn: true, customized: false });
  });

  it('persists the default mode and falls back to standard when it is removed', async () => {
    const { store } = await fixture();
    await store.save('focused', { name: 'Focused', agent: 'default' });
    expect(await store.setDefault('focused')).toBe('focused');
    expect(await store.defaultId()).toBe('focused');
    expect((await store.resolveDefault()).id).toBe('focused');

    expect(await store.remove('focused')).toBe(true);
    expect(await store.defaultId()).toBe('standard');
  });

  it('reports invalid modes loaded from disk instead of throwing', async () => {
    const { modesPath, store } = await fixture();
    await writeFile(modesPath, JSON.stringify({
      version: 1,
      modes: {
        stale: { name: 'Stale', agent: 'missing' },
        badtools: { name: 'Bad tools', agent: 'default', tools: ['missing_tool'] },
      },
    }));
    const modes = await store.list();
    expect(modes.find((mode) => mode.id === 'stale')).toMatchObject({ valid: false });
    expect(modes.find((mode) => mode.id === 'badtools')).toMatchObject({ valid: false });
  });
});
