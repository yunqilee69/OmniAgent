import { realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, parse, resolve } from 'node:path';

/** File effects only. This policy does not restrict reads, network, or process visibility. */
export type DshSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type DshConfinedMode = Exclude<DshSandboxMode, 'danger-full-access'>;

/** Trusted, per-call policy. Model-provided arguments must never be merged into this value. */
export interface DshSandboxPolicy {
  readonly mode: DshSandboxMode;
  readonly workspaceRoot: string;
  readonly additionalWritableRoots?: readonly string[];
  readonly sessionId?: string;
}

export class DshSandboxError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'DshSandboxError';
  }
}

export class DshSandboxUnavailableError extends DshSandboxError {
  constructor(detail: string) {
    super(`Sandbox unavailable: ${detail}; refusing unconfined execution`, 'SANDBOX_UNAVAILABLE');
    this.name = 'DshSandboxUnavailableError';
  }
}

export function assertDshMode(mode: unknown): asserts mode is DshSandboxMode {
  if (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'danger-full-access') {
    throw new DshSandboxError('Invalid sandbox mode', 'SANDBOX_INVALID_POLICY');
  }
}

/** Roots must already use physical absolute spellings so a changed symlink cannot widen a grant. */
export async function dshPhysicalDirectory(path: string, requirePhysical = true): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new DshSandboxError(`Invalid sandbox root ${JSON.stringify(path)}`, 'SANDBOX_INVALID_ROOT');
  }
  try {
    // Reject parent traversal in a grant before lexical normalization can hide a symlink.
    if (path.split(/[\\/]+/u).includes('..')) throw new Error('parent traversal is not allowed');
    const physical = await realpath(path);
    const info = await stat(physical);
    if (!info.isDirectory()) throw new Error('expected an existing directory');
    if (requirePhysical && physical !== resolve(path)) throw new Error(`use physical path ${JSON.stringify(physical)}`);
    return physical;
  } catch (error) {
    throw new DshSandboxError(`Invalid sandbox root ${JSON.stringify(path)}: ${String(error)}`, 'SANDBOX_INVALID_ROOT', { cause: error });
  }
}

/** Canonical workspace and explicit grants; validate on each call, never cache mutable path identity. */
export async function dshWorkspaceWritableRoots(policy: DshSandboxPolicy): Promise<string[]> {
  assertDshMode(policy.mode);
  if (policy.mode !== 'workspace-write') return [];
  const roots = await Promise.all([
    dshPhysicalDirectory(policy.workspaceRoot),
    ...(policy.additionalWritableRoots ?? []).map((path) => dshPhysicalDirectory(path)),
  ]);
  return [...new Set(roots)];
}

/** DSH workspace-write permits host temp directories (bwrap instead provides a private /tmp). */
export async function dshWritableRoots(policy: DshSandboxPolicy): Promise<string[]> {
  const roots = await dshWorkspaceWritableRoots(policy);
  if (policy.mode !== 'workspace-write') return roots;
  const temps = await Promise.all(['/tmp', tmpdir()].map((path) => dshPhysicalDirectory(path, false)));
  if (temps.some((path) => path === parse(path).root)) {
    throw new DshSandboxError('A temporary root cannot be a filesystem root', 'SANDBOX_INVALID_ROOT');
  }
  return [...new Set([...roots, ...temps])];
}
