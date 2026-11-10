import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, sep } from 'node:path';
import { assertDshMode, DshSandboxError, DshSandboxUnavailableError, dshWorkspaceWritableRoots, dshWritableRoots } from './dsh-policy.ts';
import type { DshSandboxPolicy } from './dsh-policy.ts';

export type DshSandboxBackend = 'seatbelt' | 'bwrap' | 'landlock';
export interface DshSandboxCapability {
  readonly selected?: DshSandboxBackend;
  readonly launcher?: string;
  readonly attempts: readonly { backend: DshSandboxBackend; usable: boolean; detail: string }[];
}

/** Options are trusted host configuration, never model-controlled. */
export interface DshSandboxOptions {
  readonly platform?: string;
  /** Absolute path to an operator-trusted DSH `landlock-run` binary; never resolved through PATH. */
  readonly landlockLauncher?: string;
  readonly probeTimeoutMs?: number;
  /** Test seam; supplying this asserts that the selected runner is trustworthy. */
  readonly runProbe?: (argv: readonly string[], timeoutMs: number) => { status: number | null; stdout: string; stderr?: string; error?: string };
}

export interface DshConfinedArgv {
  readonly argv: string[];
  readonly backend: DshSandboxBackend | 'none';
  readonly enforcement: 'full' | 'none';
  readonly denialSignatures: readonly string[];
}

const SEATBELT = '/usr/bin/sandbox-exec';
const BWRAP = '/usr/bin/bwrap';
const LANDLOCK_LAUNCHERS = ['/usr/local/libexec/omniagent/landlock-run', '/usr/libexec/omniagent/landlock-run'];
const PROBE_TIMEOUT_MS = 2_000;
const MAX_TIMER_MS = 2_147_483_647;
const READ_ONLY_PROFILE = '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))';

function timeoutOf(options: DshSandboxOptions): number {
  const timeout = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMER_MS) {
    throw new DshSandboxError('Invalid sandbox probe timeout', 'SANDBOX_INVALID_POLICY');
  }
  return timeout;
}

function validateLauncher(path: string): void {
  if (!isAbsolute(path) || path.includes('\0') || path.split('/').includes('..')) {
    throw new DshSandboxError('Landlock launcher must be a trusted absolute path', 'SANDBOX_INVALID_POLICY');
  }
}

function runProbe(argv: readonly string[], timeoutMs: number): { status: number | null; stdout: string; stderr: string; error?: string } {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4096,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error.message } : {}) };
}

/**
 * Probe actual profile/launcher usability. Landlock is available only if explicitly
 * configured by trusted host code and its DSH protocol reports full enforcement.
 * A probe establishes usability, not binary authenticity: the configured launcher and
 * fixed system runners must be protected from replacement by untrusted users.
 */
export function probeDshSandbox(options: DshSandboxOptions = {}): DshSandboxCapability {
  const timeout = timeoutOf(options);
  const platform = options.platform ?? process.platform;
  if (options.landlockLauncher !== undefined) validateLauncher(options.landlockLauncher);
  const probe = options.runProbe ?? runProbe;
  const attempts: { backend: DshSandboxBackend; usable: boolean; detail: string }[] = [];
  const attempt = (backend: DshSandboxBackend, argv: string[], expected?: string): boolean => {
    try {
      const result = probe(argv, timeout);
      const usable = result.status === 0 && (expected === undefined || result.stdout.trim() === expected);
      const failure = result.error || result.stderr?.trim() || `exit status ${result.status ?? 'unknown'} or incomplete enforcement`;
      attempts.push({ backend, usable, detail: usable ? 'usable' : `${argv[0]}: ${failure.slice(0, 500)}` });
      return usable;
    } catch (error) {
      attempts.push({ backend, usable: false, detail: `${argv[0]}: ${String(error).slice(0, 500)}` });
      return false;
    }
  };
  if (platform === 'darwin') {
    if (attempt('seatbelt', [SEATBELT, '-p', READ_ONLY_PROFILE, '--', '/usr/bin/true'])) {
      return { selected: 'seatbelt', attempts };
    }
  } else if (platform === 'linux') {
    if (attempt('bwrap', [BWRAP, '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', '/usr/bin/true'])) {
      return { selected: 'bwrap', attempts };
    }
    const launchers = options.landlockLauncher ? [options.landlockLauncher] : LANDLOCK_LAUNCHERS;
    for (const launcher of launchers) {
      if (attempt('landlock', [launcher, '--probe'], 'landlock: fully enforced')) {
        return { selected: 'landlock', launcher, attempts };
      }
    }
  }
  return { attempts };
}

function quoteSbpl(path: string): string {
  if (/[\x00-\x1f\x7f]/u.test(path)) throw new DshSandboxError('Control character in sandbox root', 'SANDBOX_INVALID_ROOT');
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * Wrap the exact argv; no shell interpolation occurs here. The sandbox governs file
 * writes, not reads or network, including loopback/control-plane endpoints. bwrap normally uses
 * an ephemeral /tmp, but leaves it read-only when a writable root is under /tmp. Seatbelt and
 * Landlock use host temp grants. Pre-existing hard
 * links, writable-root replacement races, IPC, and OS sandbox limitations remain outside
 * a perfect filesystem isolation guarantee. Only danger-full-access bypasses the runner.
 */
export async function confineDshArgv(
  argv: readonly string[], suppliedPolicy: DshSandboxPolicy, options: DshSandboxOptions = {},
): Promise<DshConfinedArgv> {
  const policy = { ...suppliedPolicy, additionalWritableRoots: suppliedPolicy.additionalWritableRoots?.slice() };
  const command = [...argv];
  assertDshMode(policy.mode);
  if (command.length === 0 || !command[0] || command.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new DshSandboxError('Invalid command argv', 'SANDBOX_INVALID_COMMAND');
  }
  if (policy.mode === 'danger-full-access') return { argv: command, backend: 'none', enforcement: 'none', denialSignatures: [] };
  const capability = probeDshSandbox(options);
  const selected = capability.selected;
  if (!selected) {
    const detail = capability.attempts.map((attempt) => `${attempt.backend}: ${attempt.detail}`).join('; ');
    throw new DshSandboxUnavailableError(`no usable backend for ${options.platform ?? process.platform}${detail ? ` (${detail})` : ''}; see README DSH sandbox setup`);
  }
  let prefix: string[];
  let denialSignatures: string[];
  if (selected === 'seatbelt') {
    const roots = await dshWritableRoots(policy);
    const grant = roots.length ? ` (allow file-write* ${roots.map((root) => `(subpath ${quoteSbpl(root)})`).join(' ')})` : '';
    prefix = [SEATBELT, '-p', READ_ONLY_PROFILE + grant];
    denialSignatures = ['operation not permitted'];
  } else if (selected === 'bwrap') {
    prefix = [BWRAP, '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent'];
    if (policy.mode === 'workspace-write') {
      const roots = await dshWorkspaceWritableRoots(policy);
      const rootUnderTmp = roots.some((root) => {
        const path = relative('/tmp', root);
        return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
      });
      if (!rootUnderTmp) prefix.push('--tmpfs', '/tmp');
      for (const root of roots) prefix.push('--bind', root, root);
    }
    denialSignatures = ['read-only file system'];
  } else {
    const roots = policy.mode === 'workspace-write' ? await dshWritableRoots(policy) : [];
    prefix = [capability.launcher!, '--ro', '/', '--rw', '/dev/null'];
    for (const root of roots) prefix.push('--rw', root);
    denialSignatures = ['permission denied'];
  }
  return { argv: [...prefix, '--', ...command], backend: selected, enforcement: 'full', denialSignatures };
}
