import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from './load';
import { ConfigStore } from './store';

describe('web configuration', () => {
  let root = '';
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

  it('defaults to local access without authentication and validates credentials and ports', () => {
    expect(ConfigSchema.parse({}).web).toEqual({ host: '127.0.0.1', port: 4317, auth: { enabled: false } });
    for (const auth of [{ enabled: true }, { enabled: true, username: ' ', password: 'secret' }, { enabled: true, username: 'user', password: '' }]) {
      expect(ConfigSchema.safeParse({ web: { auth } }).success).toBe(false);
    }
    for (const port of [0, 65536, 1.5, '4317']) expect(ConfigSchema.safeParse({ web: { port } }).success).toBe(false);
    expect(ConfigSchema.parse({ web: { auth: { enabled: true, username: 'user', password: ' secret ' } } }).web.auth.password).toBe(' secret ');
  });

  it('keeps internal snapshots valid and avoids secrets in errors', async () => {
    root = await mkdtemp(join(tmpdir(), 'omni-web-config-'));
    const path = join(root, 'config.json');
    await writeFile(path, JSON.stringify({ web: { auth: { enabled: true, username: 'user', password: 'secret-123' } } }));
    const store = await ConfigStore.open(path);
    expect(ConfigSchema.parse(store.snapshot.config).web.auth.password).toBe('secret-123');
    expect(store.snapshot.config.web.auth.enabled).toBe(true);
    await writeFile(path, JSON.stringify({ web: { auth: { enabled: true, username: 'user', password: '' } }, roles: { 'secret-123': {} } }));
    try {
      await store.refresh();
      throw new Error('Expected config validation failure');
    } catch (error) {
      expect(String(error)).toContain('web.auth.password');
      expect(String(error)).not.toContain('secret-123');
    }
    await writeFile(path, '{"web": "secret-123" broken');
    await expect(store.refresh()).rejects.toThrow('Invalid config.json');
    try { await store.refresh(); } catch (error) { expect(String(error)).not.toContain('secret-123'); }
  });
});
