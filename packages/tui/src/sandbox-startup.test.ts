import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { prepareLinuxSandbox } from '../../../scripts/prepare-linux-sandbox.ts';

describe('Linux sandbox startup integration', () => {
  it('skips other platforms without loading the preparation module', async () => {
    const load = vi.fn();
    const warn = vi.fn();
    await prepareLinuxSandbox({ platform: 'darwin', load, warn });
    expect(load).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('prepares on Linux and reports unsuccessful results without throwing', async () => {
    const prepareDshSandbox = vi.fn().mockResolvedValue({ status: 'unavailable', detail: 'probe failed' });
    const warn = vi.fn();
    await prepareLinuxSandbox({ platform: 'linux', load: async () => ({ prepareDshSandbox }), warn });
    expect(prepareDshSandbox).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('probe failed'));
  });

  it('reports exceptions and leaves success quiet', async () => {
    const warn = vi.fn();
    await prepareLinuxSandbox({ platform: 'linux', load: async () => { throw new Error('load failed'); }, warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('load failed'));
    warn.mockClear();
    await prepareLinuxSandbox({ platform: 'linux', load: async () => ({ prepareDshSandbox: async () => ({ status: 'ready', detail: 'ready' }) }), warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('runs the pnpm postinstall without installed dependencies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omniagent-postinstall-'));
    try {
      await mkdir(join(dir, 'scripts'));
      await mkdir(join(dir, 'packages/core/src/sandbox'), { recursive: true });
      await cp(resolve('scripts/prepare-linux-sandbox.ts'), join(dir, 'scripts/prepare-linux-sandbox.ts'));
      await writeFile(join(dir, 'package.json'), JSON.stringify({
        type: 'module', scripts: { postinstall: 'node scripts/prepare-linux-sandbox.ts' },
      }));
      await writeFile(join(dir, 'packages/core/src/sandbox/dsh-sandbox-prepare.ts'),
        "export async function prepareDshSandbox() { return { status: 'unavailable', detail: 'stub diagnostic' }; }\n");
      const result = spawnSync('pnpm', ['run', 'postinstall'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
      expect(result.status, result.stderr).toBe(0);
      if (process.platform === 'linux') expect(result.stderr).toContain('stub diagnostic');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads the actual preparation dependency chain without node_modules', async () => {
    if (process.platform !== 'linux') return;
    const dir = await mkdtemp(join(tmpdir(), 'omniagent-real-postinstall-'));
    try {
      await mkdir(join(dir, 'scripts'));
      await mkdir(join(dir, 'packages/core/src/sandbox'), { recursive: true });
      await cp(resolve('scripts/prepare-linux-sandbox.ts'), join(dir, 'scripts/prepare-linux-sandbox.ts'));
      for (const file of ['dsh-sandbox-prepare.ts', 'dsh-sandbox.ts', 'dsh-policy.ts']) {
        await cp(resolve('packages/core/src/sandbox', file), join(dir, 'packages/core/src/sandbox', file));
      }
      await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
      const result = spawnSync(process.execPath, ['scripts/prepare-linux-sandbox.ts'], {
        cwd: dir, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toMatch(/ERR_|Cannot find module|strip-only|is not a function/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
