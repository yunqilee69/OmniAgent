import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDshShellTool, executeDshShell } from './dsh-shell';
import { probeDshSandbox } from '../../sandbox/dsh-sandbox';
import type { DshSandboxPolicy } from '../../sandbox/dsh-policy';

let workdir: string;
let policy: DshSandboxPolicy;
beforeEach(async () => {
  workdir = await realpath(await mkdtemp(join(tmpdir(), 'omni-dsh-shell-')));
  policy = { mode: 'danger-full-access', workspaceRoot: workdir };
});
afterEach(async () => {
  if (workdir) await rm(workdir, { recursive: true, force: true });
});

describe('DSH shell execution', () => {
  it('executes the actual shell command and captures separate streams and status', async () => {
    const result = await executeDshShell({ command: 'printf out; printf err >&2; exit 7', cwd: workdir, policy });
    expect(result).toMatchObject({ stdout: 'out', stderr: 'err', exitCode: 7, timedOut: false, aborted: false });
    expect(result.argv.slice(-3)).toEqual(['/bin/bash', '-c', 'printf out; printf err >&2; exit 7']);
  });

  it('marks non-zero shell exits as failed tool output', async () => {
    const tool = createDshShellTool({ policy });
    const output = await tool.execute({ command: 'exit 42' }, { cwd: workdir, signal: new AbortController().signal });
    expect(output.ok).toBe(false);
  });
  it('keeps stdout and stderr within independent byte limits', async () => {
    const result = await executeDshShell({
      command: 'printf 1234567890; printf abcdefghij >&2', cwd: workdir, policy, maxOutputBytes: 5,
    });
    expect(result.stdout).toBe('12345');
    expect(result.stderr).toBe('abcde');
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  it('bounds output without retaining a large backing chunk', async () => {
    const result = await executeDshShell({
      command: 'printf "%.0sX" {1..10000}', cwd: workdir, policy, maxOutputBytes: 1,
    });
    expect(result.stdout).toBe('X');
    expect(result.stdoutTruncated).toBe(true);
  });

  it('does not leak ambient credentials or shell startup injection variables', async () => {
    process.env.OMNI_DSH_TEST_TOKEN = 'should-not-leak';
    process.env.BASH_ENV = join(workdir, 'not-used');
    try {
      const result = await executeDshShell({
        command: 'printf "%s:%s" "${OMNI_DSH_TEST_TOKEN-unset}" "${BASH_ENV-unset}"', cwd: workdir, policy,
      });
      expect(result.stdout).toBe('unset:unset');
    } finally {
      delete process.env.OMNI_DSH_TEST_TOKEN;
      delete process.env.BASH_ENV;
    }
  });

  it('reports and stops a timed-out process', async () => {
    const result = await executeDshShell({ command: 'sleep 5', cwd: workdir, policy, timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it('kills group descendants that ignore SIGTERM after the shell exits', async () => {
    let pid: number | undefined;
    try {
      const result = await executeDshShell({
        command: 'trap "" TERM; sleep 5 >/dev/null 2>&1 & printf "%s" "$!"', cwd: workdir, policy,
      });
      pid = Number(result.stdout);
      expect(pid).toBeGreaterThan(1);
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      if (pid && pid > 1) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });

  it('reports and stops cancellation and rejects an already-aborted request', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await executeDshShell({ command: 'sleep 5', cwd: workdir, policy, signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    await expect(executeDshShell({ command: 'true', policy, signal: controller.signal })).rejects.toThrow();
  });

  it('rejects invalid budgets and an unavailable sandbox without executing a command', async () => {
    await expect(executeDshShell({ command: 'true', policy, timeoutMs: 0 })).rejects.toThrow();
    await expect(executeDshShell({ command: 'true', policy, maxOutputBytes: Infinity })).rejects.toThrow();
    await expect(executeDshShell({
      command: 'true', policy: { ...policy, mode: 'read-only' }, sandbox: { platform: 'freebsd' },
    })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  });

  it('exposes the escalation schema but rejects unprocessed escalation arguments', async () => {
    const tool = createDshShellTool({ policy });
    expect(tool.parameters.safeParse({ command: 'true', sandbox_permissions: 'workspace-write', justification: 'Need it' }).success).toBe(true);
    await expect(tool.execute(
      { command: 'true', sandbox_permissions: 'workspace-write', justification: 'Need it' },
      { cwd: workdir, signal: new AbortController().signal },
    )).rejects.toThrow(/escalation/i);
    expect((await tool.execute({ command: 'printf tool-ok' }, { cwd: workdir, signal: new AbortController().signal })).content)
      .toContain('tool-ok');
  });

  it('allows workspace writes and denies sibling writes outside temporary grants', async (context) => {
    if (!probeDshSandbox().selected) return context.skip();
    const root = await realpath(await mkdtemp(join(homedir(), '.omni-dsh-native-')));
    try {
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside');
      await mkdir(workspace);
      await mkdir(outside);
      await writeFile(join(outside, 'sentinel'), 'original');
      const confinedPolicy: DshSandboxPolicy = { mode: 'workspace-write', workspaceRoot: workspace };
      const allowed = await executeDshShell({
        command: 'printf allowed > "$1"', cwd: workspace, policy: confinedPolicy,
        shellArgs: ['--', join(workspace, 'allowed')],
      });
      expect(allowed.exitCode, allowed.stderr).toBe(0);
      expect(await readFile(join(workspace, 'allowed'), 'utf8')).toBe('allowed');
      const denied = await executeDshShell({
        command: 'printf blocked > "$1"', cwd: workspace, policy: confinedPolicy,
        shellArgs: ['--', join(outside, 'denied')],
      });
      expect(denied.exitCode).not.toBe(0);
      await expect(stat(join(outside, 'denied'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('original');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses confined shell execution when a writable root contains a hard link', async (context) => {
    if (!probeDshSandbox().selected) return context.skip();
    const workspace = join(workdir, 'workspace');
    await mkdir(workspace);
    const target = join(workspace, 'target');
    await writeFile(target, 'original');
    await link(target, join(workspace, 'alias'));
    await expect(executeDshShell({
      command: 'printf changed > alias', cwd: workspace,
      policy: { mode: 'workspace-write', workspaceRoot: workspace },
    })).rejects.toMatchObject({ code: 'SANDBOX_HARDLINK_UNSAFE' });
    expect(await readFile(target, 'utf8')).toBe('original');
  });

  it('actually denies a harmless temporary file write when the OS sandbox is usable', async (context) => {
    if (!probeDshSandbox().selected) return context.skip();
    const target = join(workdir, 'denied');
    const result = await executeDshShell({
      command: 'printf harmless > "$1"', cwd: workdir,
      policy: { ...policy, mode: 'read-only' }, shellArgs: ['--', target],
    });
    expect(result.exitCode).not.toBe(0);
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
