import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '@omniagent/core';
import { projectDshPermissions } from '../../core/src/permissions/dsh-permissions';

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for TUI prompt');
    await new Promise((done) => setTimeout(done, 10));
  }
}

describe('TUI session permissions', () => {
  it('requires selection for legacy configuration and persists an explicit session preset', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'omniagent-tui-permissions-')));
    const cwd = join(home, 'workspace');
    const configDir = join(home, '.omniagent');
    await mkdir(cwd);
    await mkdir(configDir);
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ mode: 'bypass' }));
    const store = new SessionStore(join(configDir, 'sessions'));
    const legacy = await store.create({ id: 'legacy', workspace: cwd, cwd });
    await legacy.append({ type: 'message/user', data: { text: 'old' } });
    const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('packages/tui/src/main.ts')], {
      cwd, env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { output += chunk; });
    const prompts = () => (output.match(/\u276f /g) ?? []).length;
    try {
      await waitFor(() => prompts() >= 1 || child.exitCode !== null);
      expect(child.exitCode, output).toBeNull();
      const [created] = (await store.list()).filter((item) => item.id !== 'legacy');
      expect(created).toBeDefined();
      expect((await store.open(cwd, created!.id)).events).toHaveLength(0);
      child.stdin.write('/resume legacy\n');
      await waitFor(() => prompts() >= 2);
      expect((await store.open(cwd, 'legacy')).events).toHaveLength(1);
      child.stdin.write('/permission read-only\n');
      await waitFor(() => prompts() >= 3);
      expect(projectDshPermissions((await store.open(cwd, 'legacy')).events))
        .toEqual({ status: 'ready', preset: 'read-only' });
      child.stdin.write('/permission read-only\n');
      await waitFor(() => prompts() >= 4);
      expect((await store.open(cwd, 'legacy')).events.filter((event) => event.type === 'permission/dsh-preset')).toHaveLength(1);
      await (await store.open(cwd, 'legacy')).append({ type: 'permission/dsh-preset', data: { version: 9, preset: 'read-only' } });
      child.stdin.write('should be blocked\n');
      await waitFor(() => prompts() >= 5);
      expect(output).toContain('请先使用 /permission');
      expect((await store.open(cwd, 'legacy')).events.filter((event) => event.type === 'message/user')).toHaveLength(1);
      child.stdin.write('exit\n');
      await waitFor(() => child.exitCode !== null);
      expect(child.exitCode, output).toBe(0);
    } finally {
      child.kill();
    }
  }, 15000);

  it('selects and persists a session model from the configured catalog', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'omniagent-tui-model-')));
    const cwd = join(home, 'workspace');
    const configDir = join(home, '.omniagent');
    await mkdir(cwd);
    await mkdir(configDir);
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      model: 'm1',
      provider: 'test-provider',
      providers: {
        'test-provider': {
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:9/v1',
          apiKeyEnv: 'TEST_PROVIDER_KEY',
          models: [{ id: 'm1', name: 'One' }, { id: 'm2', name: 'Two' }],
        },
      },
      dsh: { permission: { defaultPreset: 'workspace-write' } },
    }));
    const store = new SessionStore(join(configDir, 'sessions'));
    const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('packages/tui/src/main.ts')], {
      cwd, env: { ...process.env, HOME: home, TEST_PROVIDER_KEY: 'test-key' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { output += chunk; });
    const prompts = () => (output.match(/\u276f /g) ?? []).length;
    try {
      await waitFor(() => prompts() >= 1 || child.exitCode !== null);
      expect(child.exitCode, output).toBeNull();
      expect(output).toContain('test-provider/m1');
      const [created] = await store.list();
      expect(created).toBeDefined();
      expect((await store.open(cwd, created!.id)).events).toContainEqual(expect.objectContaining({
        type: 'model/selected', data: { version: 1, provider: 'test-provider', model: 'm1' },
      }));
      child.stdin.write('/model\n');
      await waitFor(() => prompts() >= 2);
      expect(output).toContain('* 1. test-provider/m1');
      expect(output).toContain('2. test-provider/m2');
      child.stdin.write('/model 2\n');
      await waitFor(() => prompts() >= 3);
      const events = (await store.open(cwd, created!.id)).events;
      expect(events.filter((event) => event.type === 'model/selected').at(-1))
        .toMatchObject({ data: { version: 1, provider: 'test-provider', model: 'm2' } });
      child.stdin.write('exit\n');
      await waitFor(() => child.exitCode !== null);
      expect(child.exitCode, output).toBe(0);
    } finally {
      child.kill();
    }
  }, 15000);

  it('toggles persisted plan mode and reports an empty todo list without a provider', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'omniagent-tui-plan-')));
    const cwd = join(home, 'workspace');
    const configDir = join(home, '.omniagent');
    await mkdir(cwd);
    await mkdir(configDir);
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      dsh: { permission: { defaultPreset: 'workspace-write' } },
    }));
    const store = new SessionStore(join(configDir, 'sessions'));
    const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('packages/tui/src/main.ts')], {
      cwd, env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { output += chunk; });
    const prompts = () => (output.match(/\u276f /g) ?? []).length;
    try {
      await waitFor(() => prompts() >= 1 || child.exitCode !== null);
      expect(child.exitCode, output).toBeNull();
      const [created] = await store.list();
      expect(created).toBeDefined();
      child.stdin.write('/plan\n');
      await waitFor(() => prompts() >= 2);
      expect((await store.open(cwd, created!.id)).events.filter((event) => event.type === 'plan/mode'))
        .toContainEqual(expect.objectContaining({ data: { active: true } }));
      expect(output).toContain('计划模式已开启');
      child.stdin.write('/plan off\n');
      await waitFor(() => prompts() >= 3);
      expect((await store.open(cwd, created!.id)).events.filter((event) => event.type === 'plan/mode').at(-1))
        .toMatchObject({ data: { active: false } });
      child.stdin.write('/todos\n');
      await waitFor(() => prompts() >= 4);
      expect(output).toContain('当前没有任务清单');
      child.stdin.write('exit\n');
      await waitFor(() => child.exitCode !== null);
      expect(child.exitCode, output).toBe(0);
    } finally {
      child.kill();
    }
  }, 15000);
});
