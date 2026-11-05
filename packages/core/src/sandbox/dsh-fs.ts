import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, sep } from 'node:path';
import { assertDshMode, DshSandboxError, dshWritableRoots } from './dsh-policy';
import type { DshSandboxPolicy } from './dsh-policy';

/**
 * Trusted-code path fence, not an OS sandbox. Use the returned path immediately for the
 * mutation and check every endpoint of a move. Ancestors can still be replaced between
 * the check and the filesystem syscall (TOCTOU); it is not safe against hostile concurrent
 * filesystem actors. Hard-link checks reduce alias risks but cannot make path I/O atomic.
 * Reads are unrestricted. On Windows we fail closed rather than guess at device paths,
 * case-sensitive directories, junctions, short names, and other namespace aliases.
 */
function denied(path: string): DshSandboxError {
  return new DshSandboxError(`File mutation denied: ${JSON.stringify(path)}`, 'FS_SANDBOX_DENIED');
}

function under(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

/** Resolve existing components in filesystem order; missing suffixes may not contain `..`. */
async function physicalTarget(path: string, base: string): Promise<string> {
  if (typeof path !== 'string' || path.trim() === '' || path.includes('\0')) throw denied(String(path));
  const input = isAbsolute(path) ? path : `${base}${sep}${path}`;
  const root = parse(input).root;
  let current = root;
  let missing = false;
  const parts = input.slice(root.length).split(sep).filter((part) => part !== '' && part !== '.');
  for (const [index, part] of parts.entries()) {
    if (part === '..') {
      if (missing) throw denied(path);
      current = join(current, '..');
      continue;
    }
    const candidate = join(current, part);
    if (missing) {
      current = candidate;
      continue;
    }
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing = true;
      current = candidate;
      continue;
    }
    current = info.isSymbolicLink() ? await realpath(candidate) : candidate;
    if (info.isSymbolicLink()) info = await stat(current);
    if (index < parts.length - 1 && !info.isDirectory()) throw denied(path);
    if (index === parts.length - 1) {
      if (!info.isDirectory() && !info.isFile()) throw denied(path);
      if (info.isFile() && info.nlink > 1) throw denied(path);
    }
  }
  return current;
}

/** Return the freshly resolved path the caller must actually mutate. */
export async function checkDshMutation(path: string, policy: DshSandboxPolicy): Promise<string> {
  assertDshMode(policy.mode);
  if (policy.mode === 'read-only') throw denied(path);
  if (policy.mode === 'danger-full-access') return path;
  if (process.platform === 'win32') {
    throw new DshSandboxError('Windows filesystem alias-safe fencing is unavailable', 'SANDBOX_UNAVAILABLE');
  }
  const roots = await dshWritableRoots(policy);
  try {
    const target = await physicalTarget(path, roots[0]!);
    if (!roots.some((root) => under(target, root))) throw denied(path);
    return target;
  } catch (error) {
    if (error instanceof DshSandboxError) throw error;
    throw new DshSandboxError(`Cannot safely resolve mutation target ${JSON.stringify(path)}`, 'FS_SANDBOX_DENIED', { cause: error });
  }
}

/** Check every mutation endpoint before using any of them, for example source and destination of a move. */
export async function checkDshMutations(paths: readonly string[], policy: DshSandboxPolicy): Promise<string[]> {
  const checked: string[] = [];
  for (const path of paths) checked.push(await checkDshMutation(path, policy));
  return checked;
}
