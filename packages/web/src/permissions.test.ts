import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore, matchesCall, parseRuleSet } from '@omniagent/core';
import type { DshPermissionSnapshot } from '@omniagent/core';
import { startWebHost } from './server';
import type { WebHost, WebHostOptions } from './server';
import { PermissionSettings } from './permissions';
import { WorkspaceRegistry } from './workspaces';

const hosts: WebHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

const defaults = { defaultPreset: 'workspace-write', requiresSelection: false } as const;
const selectionRequired = { defaultPreset: null, requiresSelection: true } as const;
const preset = (defaultPreset: string) => ({ defaultPreset });
const selected = (defaultPreset: string) => ({ defaultPreset, requiresSelection: false });

async function permissionStore(path: string) {
  const module = await import('./permissions').catch(() => undefined);
  expect(module, 'the permission settings backend must exist').toBeDefined();
  return module!.PermissionSettings.open(path);
}

function put(body: unknown): RequestInit {
  return { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function setup(initial?: unknown, createSession?: WebHostOptions['createSession']) {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-web-permissions-'));
  const workspacePath = join(root, 'workspace');
  const configDir = join(root, 'global-config');
  const configPath = join(configDir, 'config.json');
  await mkdir(workspacePath);
  await mkdir(configDir);
  if (initial !== undefined) await writeFile(configPath, JSON.stringify(initial));
  const settings = await permissionStore(configPath);
  const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
  const workspace = await workspaces.add(workspacePath);
  const store = new SessionStore(join(root, 'sessions'));
  const host = await startWebHost({
    workspaces, store, permissionSettings: settings,
    createSession: createSession ?? (() => { throw new Error('unexpected session creation'); }),
  });
  hosts.push(host);
  return { root, configPath, configDir, workspace, settings, store, host, base: host.address()! };
}

async function createSession(base: string, workspaceId: string) {
  const response = await fetch(`${base}/api/workspaces/${workspaceId}/sessions`, post({}));
  expect(response.status).toBe(201);
  const { session } = await response.json() as { session: { id: string } };
  return `${base}/api/workspaces/${workspaceId}/sessions/${session.id}/messages`;
}

async function send(url: string, text = 'go') {
  const response = await fetch(url, post({ text }));
  expect(response.status).toBe(200);
  return (await response.text()).split('\n\n').filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as { type: string; decision?: string });
}

describe('permission settings API', () => {
  it('returns only permission settings and preserves unrelated config fields on write', async () => {
    const original = {
      model: 'private-model', provider: { type: 'openai', apiKey: 'SECRET_KEY', headers: { authorization: 'SECRET_HEADER' } },
      system: 'SECRET_PROMPT', maxSteps: 7, custom: { nested: true }, mode: 'plan',
      permissions: { allow: ['list_dir'], ask: [], deny: [], customPolicy: { retained: true } },
      dsh: { permission: { other: 'SECRET_POLICY' }, custom: { nested: true } },
    };
    const { base, configPath } = await setup(original);
    const get = await fetch(`${base}/api/settings/permissions`);
    expect(get.status).toBe(200);
    const body = await get.text();
    expect(JSON.parse(body)).toEqual({ settings: selectionRequired });
    for (const secret of ['SECRET_KEY', 'SECRET_HEADER', 'SECRET_PROMPT', 'private-model', 'customPolicy', 'SECRET_POLICY']) {
      expect(body).not.toContain(secret);
    }

    const next = preset('read-only');
    const response = await fetch(`${base}/api/settings/permissions`, put(next));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settings: selected('read-only') });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      ...original, dsh: { ...original.dsh, permission: { ...original.dsh.permission, ...next } },
    });
    expect(await (await permissionStore(configPath)).read()).toEqual(selected('read-only'));
  });

  it('returns a cloned full config from the trusted initial read without rereading the file', async () => {
    const original = {
      model: 'private-model', mode: 'plan', maxSteps: 7, system: 'SECRET_PROMPT',
      provider: {
        type: 'openai', baseURL: 'https://model.example/v1', apiKey: 'SECRET_KEY', apiKeyEnv: 'CUSTOM_KEY',
        headers: { authorization: 'SECRET_HEADER' }, timeoutMs: 3000, maxRetries: 2,
      },
      permissions: { allow: ['list_dir'], ask: [], deny: [] },
    };
    const { base, configPath, settings } = await setup(original);
    await writeFile(configPath, '{invalid external edit');
    const snapshot = settings.configSnapshot();
    expect(snapshot).toEqual(original);
    snapshot.mode = 'bypass';
    const provider = snapshot.provider;
    assert(provider && typeof provider !== 'string', 'Expected a legacy provider object');
    provider.apiKey = 'modified';
    provider.headers!.authorization = 'modified';
    snapshot.permissions!.allow.push('write_file');
    expect(settings.configSnapshot()).toEqual(original);
    expect(await settings.read()).toEqual(selectionRequired);
    const body = await (await fetch(`${base}/api/settings/permissions`)).text();
    for (const secret of ['SECRET_KEY', 'SECRET_HEADER', 'SECRET_PROMPT', 'private-model']) {
      expect(body).not.toContain(secret);
    }
  });

  it('returns parsed defaults from the trusted config snapshot when the file is missing', async () => {
    const { settings } = await setup();
    expect(settings.configSnapshot()).toEqual({ model: 'fake', mode: 'default', maxSteps: 25 });
  });

  it('updates the trusted full snapshot after a successful permissions write', async () => {
    const original = { model: 'configured', provider: { type: 'openai', apiKey: 'SECRET' }, mode: 'default' };
    const { settings } = await setup(original);
    await settings.update(preset('read-only'));
    expect(settings.configSnapshot()).toEqual({
      model: 'configured', mode: 'default', maxSteps: 25,
      provider: { type: 'openai', apiKey: 'SECRET', apiKeyEnv: 'OPENAI_API_KEY' },
      dsh: { permission: { defaultPreset: 'read-only' } },
    });
  });

  it('creates defaults when no config exists and serializes concurrent complete updates', async () => {
    const { base, configPath } = await setup();
    expect(await (await fetch(`${base}/api/settings/permissions`)).json()).toEqual({ settings: defaults });
    const first = preset('read-only');
    const second = preset('danger-full-access');
    const responses = await Promise.all([
      fetch(`${base}/api/settings/permissions`, put(first)),
      fetch(`${base}/api/settings/permissions`, put(second)),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const persisted = JSON.parse(await readFile(configPath, 'utf8'));
    expect([first, second]).toContainEqual(persisted.dsh.permission);
    expect((await (await fetch(`${base}/api/settings/permissions`)).json() as { settings: unknown }).settings)
      .toEqual(selected(persisted.dsh.permission.defaultPreset));
    expect(await (await permissionStore(configPath)).read()).toEqual(selected(persisted.dsh.permission.defaultPreset));
  });

  it('distinguishes fresh, legacy, explicit, and invalid persisted presets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-web-dsh-'));
    const configPath = join(root, 'config.json');
    const cases: Array<[unknown, unknown]> = [
      [{}, defaults],
      [{ provider: { apiKey: 'SECRET' }, dsh: { permission: { other: true } } }, defaults],
      [{ mode: 'bypass' }, selectionRequired],
      [{ permissions: {} }, selectionRequired],
      [{ mode: 'plan', dsh: { permission: { defaultPreset: 'read-only' } } }, selected('read-only')],
      [{ permissions: {}, dsh: { permission: { defaultPreset: 'danger-full-access' } } }, selected('danger-full-access')],
      [{ dsh: { permission: { defaultPreset: 'workspace-write' } } }, defaults],
      [{ dsh: { permission: { defaultPreset: 'bypass' } } }, selectionRequired],
      [{ dsh: { permission: { defaultPreset: null } } }, selectionRequired],
      [{ dsh: null }, selectionRequired],
      [{ dsh: { permission: [] } }, selectionRequired],
    ];
    for (const [config, expected] of cases) {
      await writeFile(configPath, JSON.stringify(config));
      const settings = await permissionStore(configPath);
      expect(await settings.read(), JSON.stringify(config)).toEqual(expected);
      expect(settings.snapshot(), JSON.stringify(config)).toEqual({ ...expected as object, revision: 0 });
      expect(JSON.stringify(settings.snapshot())).not.toContain('SECRET');
    }
  });

  it('can explicitly select each preset and advances revision only after successful updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-web-dsh-update-'));
    const configPath = join(root, 'config.json');
    const settings = await permissionStore(configPath);
    const initial = settings.snapshot();
    let revision = 0;
    for (const value of ['read-only', 'workspace-write', 'danger-full-access', 'danger-full-access']) {
      expect(await settings.update(preset(value))).toEqual(selected(value));
      expect(settings.snapshot()).toEqual({ ...selected(value), revision: ++revision });
    }
    expect(initial).toEqual({ ...defaults, revision: 0 });
    const before = await readFile(configPath, 'utf8');
    await expect(settings.update({ defaultPreset: 'bypass' })).rejects.toThrow();
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(settings.snapshot()).toEqual({ ...selected('danger-full-access'), revision });
  });

  it('requires an explicit selection to replace an invalid stored preset', async () => {
    const config = {
      mode: 'bypass',
      permissions: { allow: ['read_file(./../../.env)', 'read_file('], ask: [], deny: [] },
      provider: { apiKey: 'SECRET' },
      dsh: { permission: { defaultPreset: 'bad-preset', unrelated: 'keep' } },
    };
    const { configPath, settings } = await setup(config);
    const before = await readFile(configPath, 'utf8');
    expect(await settings.read()).toEqual(selectionRequired);
    expect(await readFile(configPath, 'utf8')).toBe(before);
    const provider = settings.configSnapshot().provider;
    assert(provider && typeof provider !== 'string', 'Expected a legacy provider object');
    expect(provider.apiKey).toBe('SECRET');
    expect(await settings.update(preset('read-only'))).toEqual(selected('read-only'));
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      ...config, dsh: { permission: { defaultPreset: 'read-only', unrelated: 'keep' } },
    });
  });

  it('does not replace malformed DSH container fields when selecting a preset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-web-dsh-containers-'));
    const configPath = join(root, 'config.json');
    for (const config of [{ dsh: null }, { dsh: 'other' }, { dsh: { permission: null } }, { dsh: { permission: [] } }]) {
      const text = JSON.stringify(config);
      await writeFile(configPath, text);
      const settings = await permissionStore(configPath);
      expect(await settings.read()).toEqual(selectionRequired);
      await expect(settings.update(preset('read-only'))).rejects.toThrow();
      expect(await readFile(configPath, 'utf8')).toBe(text);
      expect(settings.snapshot()).toEqual({ ...selectionRequired, revision: 0 });
    }
  });

  it('rejects malformed settings without changing the trusted state or config', async () => {
    const { base, configPath, settings } = await setup({ mode: 'default', provider: { apiKey: 'SECRET' } });
    const before = await readFile(configPath, 'utf8');
    const malformed = [
      {}, { defaultPreset: null }, { defaultPreset: 1 }, { defaultPreset: [] },
      { defaultPreset: 'bypass' }, { defaultPreset: 'workspace-write ' },
      { defaultPreset: 'WORKSPACE-WRITE' }, { ...preset('read-only'), extra: true },
      { ...preset('read-only'), requiresSelection: false },
      { mode: 'bypass', permissions: { allow: [], ask: [], deny: [] } },
      ...[
        'read_file()', 'read_file(./../../.omniagent/config.json)', 'read_file(./secret',
        'unknown(path)', 'read_file\n', '*()', 'read_file(./docs/**/../.env)',
        'read_file(foo))', 'read_file(foo(bar)', 'read_file(foo)(bar)',
        'read_file(./../(secrets)/file)',
      ].map((rule) => ({
        ...preset('danger-full-access'), permissions: { allow: [rule], ask: [], deny: [] },
      })),
    ];
    for (const value of malformed) {
      const response = await fetch(`${base}/api/settings/permissions`, put(value));
      expect(response.status, JSON.stringify(value)).toBe(400);
      expect(await response.text()).not.toContain('SECRET');
    }
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(settings.snapshot()).toEqual({ ...selectionRequired, revision: 0 });
    expect(await (await fetch(`${base}/api/settings/permissions`)).json()).toEqual({ settings: selectionRequired });
    expect((await fetch(`${base}/api/settings/permissions`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400);
    expect((await fetch(`${base}/api/settings/permissions`, { method: 'PUT', body: '{}' })).status).toBe(415);
    expect((await fetch(`${base}/api/settings/permissions`, put({ data: 'x'.repeat(70_000) }))).status).toBe(413);
  });

  it.skipIf(process.platform === 'win32')('preserves literal parentheses and backslashes in legacy file rules', async () => {
    const rules = ['read_file(./docs/(draft)/report.txt)', 'read_file(./docs/foo\\bar.txt)'];
    const initial = { mode: 'default', permissions: { allow: rules, ask: [], deny: [] } };
    const { base, configPath, settings, workspace } = await setup(initial);
    expect(await (await fetch(`${base}/api/settings/permissions`)).json()).toEqual({ settings: selectionRequired });
    const response = await fetch(`${base}/api/settings/permissions`, put(preset('read-only')));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settings: selected('read-only') });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      ...initial, dsh: { permission: { defaultPreset: 'read-only' } },
    });
    const [parentheses, backslash] = parseRuleSet(settings.configSnapshot().permissions!, 'user', workspace.path);
    expect(matchesCall(parentheses!, { id: 'p', name: 'read_file', arguments: { path: './docs/(draft)/report.txt' } }, workspace.path)).toBe(true);
    expect(matchesCall(backslash!, { id: 'b', name: 'read_file', arguments: { path: './docs/foo\\bar.txt' } }, workspace.path)).toBe(true);
    expect(matchesCall(backslash!, { id: 'n', name: 'read_file', arguments: { path: './docs/foo/bar.txt' } }, workspace.path)).toBe(false);
    expect(await (await permissionStore(configPath)).read()).toEqual(selected('read-only'));
  });

  it('rejects malformed existing configuration and never treats it as defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-web-permissions-invalid-'));
    const config = join(root, 'config.json');
    for (const text of ['{', '[]', '{"mode":"not-a-mode"}', '{"provider":{"apiKey":123}}']) {
      await writeFile(config, text);
      await expect(permissionStore(config)).rejects.toThrow();
    }
  });

  it('rejects symlinked config files and does not replace a linked target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-permissions-link-'));
    const target = join(root, 'target.json');
    const link = join(root, 'config.json');
    await writeFile(target, JSON.stringify({ mode: 'bypass' }));
    await symlink(target, link);
    await expect(permissionStore(link)).rejects.toThrow();
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ mode: 'bypass' });
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO config without blocking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-permissions-fifo-'));
    const config = join(root, 'config.json');
    await writeFile(config, JSON.stringify({ mode: 'default' }));
    const script = `
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import { unlink } from 'node:fs/promises';
      const { PermissionSettings } = await import(${JSON.stringify(new URL('./permissions.ts', import.meta.url).href)});
      const path = process.argv[1];
      const settings = await PermissionSettings.open(path);
      await unlink(path);
      execFileSync('mkfifo', [path]);
      console.log('FIFO_READY');
      await assert.rejects(settings.update({ defaultPreset: 'danger-full-access' }), /regular file/);
      assert.deepEqual(await settings.read(), { defaultPreset: null, requiresSelection: true });
      await assert.rejects(PermissionSettings.open(path), /regular file/);
    `;
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, config], {
      timeout: 3000,
    }).catch((error: Error & { killed?: boolean; stdout?: string }) => {
      if (error.killed && error.stdout?.includes('FIFO_READY')) throw new Error('FIFO config blocked the settings update');
      throw error;
    });
    expect(result.stdout).toContain('FIFO_READY');
  }, 10_000);

  it('rejects symlinked config parent directories and does not touch the target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-permissions-parent-link-'));
    const targetDir = join(root, 'target');
    const workspaceDir = join(root, 'workspace');
    const linkedDir = join(workspaceDir, '.omniagent');
    await mkdir(targetDir);
    await mkdir(workspaceDir);
    const target = join(targetDir, 'config.json');
    await writeFile(target, JSON.stringify({ mode: 'default' }));
    await symlink(targetDir, linkedDir);
    await expect(permissionStore(join(linkedDir, 'config.json'))).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe(JSON.stringify({ mode: 'default' }));
  });

  it('accepts an explicitly trusted symlinked home for reads and updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-permissions-home-link-'));
    const realHome = join(root, 'real-home');
    const home = join(root, 'home');
    const config = join(home, '.omniagent', 'config.json');
    await mkdir(join(realHome, '.omniagent'), { recursive: true });
    await writeFile(join(realHome, '.omniagent', 'config.json'), JSON.stringify({ mode: 'default' }));
    await symlink(realHome, home);

    await expect(PermissionSettings.open(config)).rejects.toThrow();
    const settings = await PermissionSettings.open(config, { trustedHome: home });
    const next = preset('read-only');
    await expect(settings.update(next)).resolves.toEqual(selected('read-only'));
    expect(settings.snapshot()).toEqual({ ...selected('read-only'), revision: 1 });
    expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({ mode: 'default', dsh: { permission: next } });
    expect(await (await PermissionSettings.open(config, { trustedHome: home })).read()).toEqual(selected('read-only'));
  });

  it('supports nested symlinks inside the trusted home prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-permissions-home-chain-'));
    const realParent = join(root, 'real-parent');
    const aliasParent = join(root, 'alias-parent');
    const actualHome = join(root, 'actual-home');
    await mkdir(realParent);
    await mkdir(actualHome);
    await symlink(actualHome, join(realParent, 'home'));
    await symlink(realParent, aliasParent);
    const home = join(aliasParent, 'home');
    const config = join(home, '.omniagent', 'config.json');
    const settings = await PermissionSettings.open(config, { trustedHome: home });
    await settings.update(preset('read-only'));
    expect(JSON.parse(await readFile(join(actualHome, '.omniagent', 'config.json'), 'utf8')))
      .toEqual({ dsh: { permission: preset('read-only') } });
  });

  it('rejects symlinks below an explicitly trusted home on open and update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-permissions-home-internal-'));
    const realHome = join(root, 'real-home');
    const home = join(root, 'home');
    const target = join(root, 'target');
    const configDir = join(realHome, '.omniagent');
    const configPath = join(home, '.omniagent', 'config.json');
    await mkdir(configDir, { recursive: true });
    await mkdir(target);
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ mode: 'default' }));
    await writeFile(join(target, 'config.json'), JSON.stringify({ mode: 'bypass' }));
    await symlink(realHome, home);
    const settings = await PermissionSettings.open(configPath, { trustedHome: home });
    await rename(configDir, join(realHome, 'moved-config'));
    await symlink(target, configDir);
    await expect(PermissionSettings.open(configPath, { trustedHome: home })).rejects.toThrow();
    await expect(settings.update(preset('read-only'))).rejects.toThrow();
    expect(await settings.read()).toEqual(selectionRequired);
    expect(JSON.parse(await readFile(join(target, 'config.json'), 'utf8'))).toEqual({ mode: 'bypass' });
  });

  it('rejects a trusted home link retargeted after opening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-permissions-home-retarget-'));
    const realHome = join(root, 'real-home');
    const redirectedHome = join(root, 'redirected-home');
    const home = join(root, 'home');
    for (const dir of [realHome, redirectedHome]) {
      await mkdir(join(dir, '.omniagent'), { recursive: true });
      await writeFile(join(dir, '.omniagent', 'config.json'), JSON.stringify({ mode: 'default' }));
    }
    await symlink(realHome, home);
    const settings = await PermissionSettings.open(join(home, '.omniagent', 'config.json'), { trustedHome: home });
    await rename(home, join(root, 'old-home-link'));
    await symlink(redirectedHome, home);
    await expect(settings.update(preset('danger-full-access'))).rejects.toThrow();
    expect(await settings.read()).toEqual(selectionRequired);
    for (const dir of [realHome, redirectedHome]) {
      expect(JSON.parse(await readFile(join(dir, '.omniagent', 'config.json'), 'utf8'))).toEqual({ mode: 'default' });
    }
  });

  it('requires a config path inside the explicitly trusted home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-permissions-home-scope-'));
    const home = join(root, 'home');
    const outside = join(root, 'home-other', 'config.json');
    await mkdir(home);
    await mkdir(join(root, 'home-other'));
    await expect(PermissionSettings.open(outside, { trustedHome: home })).rejects.toThrow();
  });

  it('rejects a parent replaced by a symlink before an update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-permissions-update-link-'));
    const trustedDir = join(root, 'trusted');
    const redirectedDir = join(root, 'redirected');
    const movedDir = join(root, 'moved');
    await mkdir(trustedDir);
    await mkdir(redirectedDir);
    const config = join(trustedDir, 'config.json');
    const redirected = join(redirectedDir, 'config.json');
    await writeFile(config, JSON.stringify({ mode: 'default' }));
    await writeFile(redirected, JSON.stringify({ mode: 'bypass' }));
    const settings = await permissionStore(config);
    await rename(trustedDir, movedDir);
    await symlink(redirectedDir, trustedDir);
    await expect(settings.update(preset('read-only'))).rejects.toThrow();
    expect(JSON.parse(await readFile(redirected, 'utf8'))).toEqual({ mode: 'bypass' });
  });

  it('rejects hostile Host and Origin on both settings operations', async () => {
    const { base } = await setup();
    for (const init of [{}, put(preset('read-only'))]) {
      const response = await fetch(`${base}/api/settings/permissions`, {
        ...init, headers: { ...(init.headers as Record<string, string> | undefined), origin: 'https://attacker.example' },
      });
      expect(response.status).toBe(403);
      const crossLoopback = await fetch(`${base}/api/settings/permissions`, {
        ...init, headers: { ...(init.headers as Record<string, string> | undefined), origin: base.replace('127.0.0.1', 'localhost') },
      });
      expect(crossLoopback.status).toBe(403);
    }
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${base}/api/settings/permissions`, { headers: { host: 'attacker.example' } }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject); request.end();
    });
    expect(status).toBe(403);
  });

  it('keeps the last trusted permissions when workspace or external files are changed', async () => {
    const { base, configPath, workspace } = await setup();
    await mkdir(join(workspace.path, '.omniagent'));
    await writeFile(join(workspace.path, '.omniagent', 'config.json'), JSON.stringify({ mode: 'bypass' }));
    await writeFile(configPath, JSON.stringify({ mode: 'bypass' }));
    expect(await (await fetch(`${base}/api/settings/permissions`)).json()).toEqual({ settings: defaults });
    const response = await fetch(`${base}/api/settings/permissions`, put(preset('read-only')));
    expect(response.status).toBe(500);
    expect(await (await fetch(`${base}/api/settings/permissions`)).json()).toEqual({ settings: defaults });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ mode: 'bypass' });
  });

  it('does not trust files edited through a workspace that contains the global config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-permissions-workspace-'));
    const workspacePath = join(root, 'workspace');
    const configDir = join(workspacePath, '.omniagent');
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    await writeFile(configPath, JSON.stringify({ mode: 'default' }));
    const settings = await permissionStore(configPath);
    const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
    await workspaces.add(workspacePath);
    const host = await startWebHost({
      workspaces, store: new SessionStore(join(root, 'sessions')), permissionSettings: settings,
      createSession: () => { throw new Error('unexpected session creation'); },
    });
    hosts.push(host);
    await writeFile(configPath, JSON.stringify({ mode: 'bypass' }));
    expect(settings.snapshot()).toEqual({ ...selectionRequired, revision: 0 });
    expect((await fetch(`${host.address()}/api/settings/permissions`, put(preset('read-only')))).status).toBe(500);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ mode: 'bypass' });
  });

  it.skipIf(process.geteuid?.() === 0)('does not apply a failed config write to runtime settings', async () => {
    const { base, configDir, configPath } = await setup({ mode: 'default' });
    await chmod(configDir, 0o500);
    try {
      const response = await fetch(`${base}/api/settings/permissions`, put(preset('danger-full-access')));
      expect(response.status).toBe(500);
      expect(await (await fetch(`${base}/api/settings/permissions`)).json()).toEqual({ settings: selectionRequired });
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ mode: 'default' });
    } finally {
      await chmod(configDir, 0o700);
    }
  });

  it('loads persisted permission settings after a service restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-permissions-restart-'));
    const configPath = join(root, 'config.json');
    const first = await permissionStore(configPath);
    await first.update(preset('read-only'));
    const second = await permissionStore(configPath);
    expect(await second.read()).toEqual(selected('read-only'));
    expect(second.snapshot()).toEqual({ ...selected('read-only'), revision: 0 });
  });

  it('retains the session preset across a default update and the next turn', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { started = resolve; });
    const snapshots: DshPermissionSnapshot[] = [];
    const sessionSnapshot = { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' } as const;
    const { base, workspace, settings } = await setup(undefined, (_workspace, handle, effective) => {
      snapshots.push(effective);
      return {
        id: handle.id,
        async *send() {
          started();
          yield { type: 'turn.start', step: 0 };
          await gate;
          yield { type: 'turn.end', reason: 'end_turn' };
        },
        interrupt() { release(); },
      };
    });
    const url = await createSession(base, workspace.id);
    const pending = send(url, 'first');
    await active;
    try {
      expect(settings.snapshot()).toEqual({ ...defaults, revision: 0 });
      expect((await fetch(`${base}/api/settings/permissions`, put(preset('read-only')))).status).toBe(409);
      expect((await fetch(`${url.replace(/\/messages$/u, '')}/permission`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preset: 'danger-full-access' }),
      })).status).toBe(409);
      expect(settings.snapshot()).toEqual({ ...defaults, revision: 0 });
      expect(snapshots).toEqual([sessionSnapshot]);
    } finally {
      release();
      await pending;
    }
    expect((await fetch(`${base}/api/settings/permissions`, put(preset('read-only')))).status).toBe(200);
    expect(settings.snapshot()).toEqual({ ...selected('read-only'), revision: 1 });
    await send(url, 'second');
    expect(snapshots).toEqual([sessionSnapshot]);
  });
});
