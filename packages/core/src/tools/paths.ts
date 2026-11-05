import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * 工作区内的路径解析（第一道防线，不是沙盒）。
 *
 * 这里只做纯字符串层面的越权检查，**不解析符号链接**；读取工具应使用
 * `resolveInsidePhysical`，它在真正读取前解析现有路径的物理位置。两者都不是
 * OS 沙盒，也无法消除检查与系统调用之间的 TOCTOU。
 */
export function resolveInside(cwd: string, input: string): string {
  const absolute = resolve(cwd, input);
  const rel = relative(cwd, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越出工作区：${input}`);
  }
  return absolute;
}

function isUnder(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolve a read path to its physical location and require the result to stay
 * under the physical workspace root. Existing symlinks (including the final
 * component) are followed before the containment check; missing suffixes are
 * appended to the physically resolved parent. Dangling links fail closed.
 *
 * The physical path is what the caller must read. The check still races a
 * same-user process that swaps a path component after resolution.
 */
export async function resolveInsidePhysical(cwd: string, input: string): Promise<string> {
  const absolute = resolveInside(cwd, input);
  const root = await realpath(cwd);
  let current = absolute;
  const missing: string[] = [];

  while (true) {
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (current === dirname(current)) throw error;
      missing.push(basename(current));
      current = dirname(current);
      continue;
    }

    if (info.isSymbolicLink()) {
      const target = await realpath(current);
      const resolved = missing.length === 0
        ? target
        : resolve(target, ...missing.slice().reverse());
      if (!isUnder(root, resolved)) throw new Error(`路径越出工作区：${input}`);
      return resolved;
    }

    const physical = await realpath(current);
    if (!isUnder(root, physical)) throw new Error(`路径越出工作区：${input}`);
    if (missing.length === 0) return physical;
    return resolve(physical, ...missing.slice().reverse());
  }
}

/** 用来读显示的相对路径。 */
export function displayPath(cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute);
  return rel === '' ? '.' : rel;
}
