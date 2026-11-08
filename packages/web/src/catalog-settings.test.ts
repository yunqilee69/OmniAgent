import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidRoleSettings, RoleSettings } from './catalog-settings';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

const baseConfig = {
  model: 'deepseek-flash',
  provider: 'deepseek-official',
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-role-settings-'));
  roots.push(root);
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(baseConfig));
  return { root, path, settings: await RoleSettings.open(path) };
}

describe('RoleSettings', () => {
  it('lists the implicit default role and saves a named role', async () => {
    const { path, settings } = await fixture();
    const initial = await settings.list();
    expect(initial.roles.find((role) => role.id === 'default')).toMatchObject({
      id: 'default', builtIn: true, valid: true, provider: 'deepseek-official',
    });

    const saved = await settings.save('quick', {
      name: 'Quick',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'low',
    });
    expect(saved).toMatchObject({
      id: 'quick', name: 'Quick', provider: 'deepseek-official', model: 'deepseek-v4-pro',
      reasoningEffort: 'low', valid: true,
    });
    const file = JSON.parse(await readFile(path, 'utf8')) as { roles: Record<string, unknown> };
    expect(file.roles.quick).toEqual({
      name: 'Quick', provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'low',
    });
  });

  it('rejects invalid sources before touching config.json', async () => {
    const { path, settings } = await fixture();
    const before = await readFile(path, 'utf8');
    await expect(settings.save('broken', {
      provider: 'missing-provider',
      model: 'missing-model',
    })).rejects.toBeInstanceOf(InvalidRoleSettings);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('rejects unknown fields and invalid ids', async () => {
    const { settings } = await fixture();
    await expect(settings.save('Bad Id', { provider: 'deepseek-official', model: 'deepseek-flash' }))
      .rejects.toBeInstanceOf(InvalidRoleSettings);
    await expect(settings.save('quick', {
      provider: 'deepseek-official', model: 'deepseek-flash', secret: true,
    } as never)).rejects.toBeInstanceOf(InvalidRoleSettings);
  });

  it('removes a saved role and keeps an implicit built-in untouched', async () => {
    const { settings } = await fixture();
    await settings.save('quick', { provider: 'deepseek-official', model: 'deepseek-v4-pro' });
    expect(await settings.remove('quick')).toBe(true);
    expect((await settings.list()).roles.some((role) => role.id === 'quick')).toBe(false);
    expect(await settings.remove('default')).toBe(false);
    expect((await settings.list()).roles.find((role) => role.id === 'default')).toMatchObject({ builtIn: true, valid: true });
  });

  it('refuses a configuration path outside the trusted home and a symlinked config', async () => {
    const { root, path } = await fixture();
    await expect(RoleSettings.open(path, { trustedHome: join(root, 'elsewhere') }))
      .rejects.toThrow(/inside the trusted home/);

    const target = join(root, 'target.json');
    await writeFile(target, JSON.stringify(baseConfig));
    const link = join(root, 'linked.json');
    await symlink(target, link);
    await expect(RoleSettings.open(link)).rejects.toThrow();
  });
});
