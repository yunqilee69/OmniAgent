import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, ConfigStore } from './store';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-config-store-'));
  roots.push(root);
  return { root, path: join(root, 'config.json'), agents: join(root, 'agents') };
}

describe('ConfigStore', () => {
  it('loads defaults when config.json is absent', async () => {
    const { root, path } = await fixture();
    const store = await ConfigStore.open(path);
    expect(store.snapshot).toMatchObject({ path, configDir: root, config: { model: 'fake', maxSteps: 25 } });
    expect(store.snapshot.revision).toBeTruthy();
  });

  it('refreshes revisions when content changes and reuses the snapshot otherwise', async () => {
    const { path } = await fixture();
    await writeFile(path, JSON.stringify({ model: 'deepseek-flash', provider: 'deepseek-official' }));
    const store = await ConfigStore.open(path);
    const first = await store.refresh();
    expect(store.snapshot).toBe(first);
    expect(first.catalog.roles.get('default')).toMatchObject({ model: 'deepseek-flash' });

    await writeFile(path, JSON.stringify({
      model: 'deepseek-flash', provider: 'deepseek-official',
      roles: { quick: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
    }));
    const second = await store.refresh();
    expect(second.revision).not.toBe(first.revision);
    expect(second.catalog.roles.has('quick')).toBe(true);
  });

  it('fails closed on invalid JSON or schema instead of keeping stale configuration', async () => {
    const { path } = await fixture();
    await writeFile(path, JSON.stringify({ model: 'deepseek-flash', provider: 'deepseek-official' }));
    const store = await ConfigStore.open(path);
    const valid = store.snapshot;
    await writeFile(path, '{not json');
    await expect(store.refresh()).rejects.toBeInstanceOf(ConfigError);
    expect(store.snapshot).toBe(valid);

    await writeFile(path, JSON.stringify({ model: 'deepseek-flash', provider: 'deepseek-official', roles: { broken: {} } }));
    await expect(store.refresh()).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects a symlinked config.json', async () => {
    const { root, path } = await fixture();
    const target = join(root, 'outside.json');
    await writeFile(target, JSON.stringify({ model: 'fake' }));
    await symlink(target, path);
    await expect(ConfigStore.open(path)).rejects.toBeInstanceOf(ConfigError);
  });
});
