import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveTeamWorktree } from './worktree';

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

async function git(cwd: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd });
}

describe('team worktree cwd', () => {
  it('accepts another worktree of the same repository and rejects everything else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-worktree-'));
    roots.push(root);
    const repo = join(root, 'repo');
    const linked = join(root, 'linked');
    const other = join(root, 'other');
    await git(root, ['init', repo]);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    await exec('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo });
    await git(repo, ['worktree', 'add', '--detach', linked]);
    await git(root, ['init', other]);

    const resolved = await resolveTeamWorktree(repo, linked);
    expect(resolved).toBe(await import('node:fs/promises').then(({ realpath }) => realpath(linked)));
    await expect(resolveTeamWorktree(repo, other)).rejects.toThrow(/worktree/);
    await expect(resolveTeamWorktree(repo, join(root, 'missing'))).rejects.toThrow(/不存在/);
  });
});
