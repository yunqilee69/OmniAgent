import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * A child session may work in another checkout of the same repository.
 *
 * The parent cwd check refuses anything outside the parent directory. A git
 * worktree is often a sibling of that directory, so containment alone rejects
 * the one location parallel work needs. This allows that location and no other:
 * the candidate must be a worktree of the repository that contains the parent.
 */

const execFileAsync = promisify(execFile);

export async function resolveTeamWorktree(parentCwd: string, requested: string): Promise<string> {
  const candidate = resolve(parentCwd, requested);
  let physical: string;
  try {
    physical = await realpath(candidate);
  } catch {
    throw new Error(`工作目录不存在：${requested}`);
  }
  const parentRoot = await gitCommonDir(parentCwd);
  const candidateRoot = await gitCommonDir(physical);
  if (parentRoot === undefined || candidateRoot === undefined || parentRoot !== candidateRoot) {
    throw new Error(`工作目录不是当前仓库的 worktree：${requested}`);
  }
  return physical;
}

/** Absolute common git dir, or undefined when the path is not inside a worktree. */
export async function gitCommonDir(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      timeout: 5_000,
      windowsHide: true,
    });
    const text = stdout.trim();
    if (text === '') return undefined;
    return await realpath(resolve(cwd, text));
  } catch {
    return undefined;
  }
}

