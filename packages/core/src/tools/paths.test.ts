import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDirTool } from './builtin/list-dir';
import { readFileTool } from './builtin/read-file';
import { resolveInsidePhysical } from './paths';

let fixture: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(homedir(), '.omni-paths-')));
  workspace = join(fixture, 'workspace');
  outside = join(fixture, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
});

afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe('physical read paths', () => {
  it('resolves an ordinary path and a missing descendant under the workspace', async () => {
    expect(await resolveInsidePhysical(workspace, 'new/file.txt')).toBe(join(workspace, 'new/file.txt'));
    await writeFile(join(workspace, 'file.txt'), 'inside');
    expect(await resolveInsidePhysical(workspace, 'file.txt')).toBe(join(workspace, 'file.txt'));
  });

  it('permits a symlink whose target stays inside the workspace', async () => {
    await writeFile(join(workspace, 'real.txt'), 'inside');
    await symlink(join(workspace, 'real.txt'), join(workspace, 'alias.txt'));
    expect(await resolveInsidePhysical(workspace, 'alias.txt')).toBe(join(workspace, 'real.txt'));
  });

  it('rejects a symlink file, a symlink directory, and a symlink parent that escape', async () => {
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'OUTSIDE_SECRET');
    await symlink(secret, join(workspace, 'file-link'));
    await symlink(outside, join(workspace, 'dir-link'));
    for (const path of ['file-link', 'dir-link', 'dir-link/secret.txt']) {
      await expect(resolveInsidePhysical(workspace, path)).rejects.toThrow(/越出工作区/);
    }
  });

  it('fails closed for a dangling symlink and a symlink loop', async () => {
    await symlink(join(outside, 'missing.txt'), join(workspace, 'dangling'));
    await symlink('loop', join(workspace, 'loop'));
    for (const path of ['dangling', 'loop']) {
      await expect(resolveInsidePhysical(workspace, path)).rejects.toThrow();
    }
  });

  it('applies the same physical fence to read_file and list_dir', async () => {
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'OUTSIDE_SECRET');
    await symlink(secret, join(workspace, 'file-link'));
    await symlink(outside, join(workspace, 'dir-link'));
    const signal = new AbortController().signal;
    await expect(readFileTool.execute({ path: 'file-link' }, { cwd: workspace, signal }))
      .rejects.toThrow(/越出工作区/);
    await expect(listDirTool.execute({ path: 'dir-link' }, { cwd: workspace, signal }))
      .rejects.toThrow(/越出工作区/);
  });

  it('reads a real file and lists a real directory after the physical check', async () => {
    await writeFile(join(workspace, 'file.txt'), 'inside');
    await mkdir(join(workspace, 'sub'));
    const signal = new AbortController().signal;
    expect((await readFileTool.execute({ path: 'file.txt' }, { cwd: workspace, signal })).content)
      .toContain('inside');
    expect((await listDirTool.execute({ path: '.' }, { cwd: workspace, signal })).content)
      .toContain('file.txt');
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('inside');
  });
});
