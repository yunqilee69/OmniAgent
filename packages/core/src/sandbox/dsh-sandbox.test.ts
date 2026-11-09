import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confineDshArgv, probeDshSandbox } from './dsh-sandbox';
import type { DshSandboxPolicy } from './dsh-policy';

let fixture: string;
let workspace: string;
let policy: DshSandboxPolicy;

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(homedir(), '.omni-dsh-profile-')));
  workspace = join(fixture, 'workspace');
  await mkdir(workspace);
  policy = { mode: 'workspace-write', workspaceRoot: workspace, sessionId: 'session' };
});

afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe('DSH sandbox capability and argv', () => {
  it('fails closed on unsupported platforms', async () => {
    const probe = vi.fn();
    const options = { platform: 'freebsd', runProbe: probe };
    expect(probeDshSandbox(options).selected).toBeUndefined();
    await expect(confineDshArgv(['/bin/printf', 'hello'], policy, options))
      .rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('passes through exact argv only with explicit danger-full-access', async () => {
    const argv = ['/bin/printf', '%s', 'literal; not shell code'];
    expect(await confineDshArgv(argv, { ...policy, mode: 'danger-full-access' }, { platform: 'freebsd' }))
      .toMatchObject({ argv, backend: 'none', enforcement: 'none' });
    await expect(confineDshArgv([], { ...policy, mode: 'danger-full-access' })).rejects.toThrow();
  });

  it('wraps exact argv in an escaped Seatbelt profile and reports its backend', async () => {
    const extra = join(fixture, 'extra"quoted');
    await mkdir(extra);
    const command = ['/bin/bash', '-c', 'printf "%s" "$HOME"'];
    const result = await confineDshArgv(command, { ...policy, additionalWritableRoots: [extra] }, {
      platform: 'darwin',
      runProbe: () => ({ status: 0, stdout: '' }),
    });
    expect(result.backend).toBe('seatbelt');
    expect(result.argv.slice(-4)).toEqual(['--', ...command]);
    expect(result.argv[0]).toBe('/usr/bin/sandbox-exec');
    expect(result.argv[2]).toContain('(deny file-write*)');
    expect(result.argv[2]).toContain(`(subpath "${workspace}")`);
    expect(result.argv[2]).toContain('extra\\"quoted');
  });

  it('uses the Linux bwrap profile with private proc and exact command argv', async () => {
    const command = ['/bin/printf', '%s', 'a b;$x'];
    const result = await confineDshArgv(command, policy, {
      platform: 'linux',
      runProbe: () => ({ status: 0, stdout: '' }),
    });
    expect(result.backend).toBe('bwrap');
    expect(result.argv).toContain('--unshare-pid');
    expect(result.argv).toContain('--tmpfs');
    expect(result.argv).toEqual(expect.arrayContaining(['--ro-bind', '/', '--bind', workspace]));
    expect(result.argv.slice(-4)).toEqual(['--', ...command]);
  });

  it('selects only a trusted, absolute Landlock launcher with the exact full probe report', async () => {
    const runProbe = vi.fn((argv: readonly string[]) => argv[0] === '/usr/bin/bwrap'
      ? { status: 1, stdout: '' }
      : { status: 0, stdout: 'landlock: fully enforced\n' });
    const options = { platform: 'linux', landlockLauncher: '/opt/dsh/landlock-run', runProbe };
    const result = await confineDshArgv(['/bin/true'], policy, options);
    expect(result.backend).toBe('landlock');
    expect(result.argv).toEqual(expect.arrayContaining(['--ro', '/', '--rw', '/dev/null', '--rw', workspace]));
    expect(result.argv.slice(-2)).toEqual(['--', '/bin/true']);
    expect(runProbe).toHaveBeenCalledWith(['/opt/dsh/landlock-run', '--probe'], expect.any(Number));
    await expect(confineDshArgv(['/bin/true'], policy, { ...options, landlockLauncher: 'landlock-run' }))
      .rejects.toThrow();
  });

  it.each(['', 'anything', 'landlock: partially enforced (older ABI)\n'])(
    'never treats an unrecognized or partial Landlock report as full enforcement: %j',
    async (stdout) => {
      const options = {
        platform: 'linux', landlockLauncher: '/opt/dsh/landlock-run',
        runProbe: (argv: readonly string[]) => argv[0] === '/usr/bin/bwrap'
          ? { status: 1, stdout: '' } : { status: 0, stdout },
      };
      expect(probeDshSandbox(options).selected).toBeUndefined();
      await expect(confineDshArgv(['/bin/true'], policy, options))
        .rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    },
  );

  it('reports probe failures while refusing unconfined execution', async () => {
    const options = {
      platform: 'linux',
      runProbe: () => ({ status: 1, stdout: '', stderr: 'namespace access denied' }),
    };
    await expect(confineDshArgv(['/bin/true'], policy, options))
      .rejects.toThrow(/namespace access denied.*refusing unconfined execution/);
  });

  it('keeps the original tmp visible when a writable root lies beneath it', async () => {
    const tmpWorkspace = await realpath(await mkdtemp('/tmp/omni-dsh-bind-'));
    const nested = join(tmpWorkspace, 'parent', 'workspace');
    await mkdir(nested, { recursive: true });
    try {
      const result = await confineDshArgv(['/bin/true'], { ...policy, workspaceRoot: nested }, {
        platform: 'linux', runProbe: () => ({ status: 0, stdout: '' }),
      });
      expect(result.argv).not.toContain('--tmpfs');
      expect(result.argv).toEqual(expect.arrayContaining(['--bind', nested]));
    } finally {
      await rm(tmpWorkspace, { recursive: true, force: true });
    }
  });

  it('rejects unknown modes at runtime rather than treating them as a bypass', async () => {
    await expect(confineDshArgv(['/bin/true'], { ...policy, mode: 'unknown' as DshSandboxPolicy['mode'] }))
      .rejects.toThrow();
  });
});
