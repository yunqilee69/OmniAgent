import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDshMutation, checkDshMutations } from './dsh-fs';
import type { DshSandboxPolicy } from './dsh-policy';

let fixture: string;
let workspace: string;
let outside: string;
let policy: DshSandboxPolicy;

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(homedir(), '.omni-dsh-fence-')));
  workspace = join(fixture, 'workspace');
  outside = join(fixture, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  policy = { mode: 'workspace-write', workspaceRoot: workspace };
});

afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe('DSH filesystem mutation fence', () => {
  it('allows a missing descendant and returns the physical path to use', async () => {
    expect(await checkDshMutation('new/file.txt', policy)).toBe(join(workspace, 'new/file.txt'));
  });

  it('rejects all read-only mutations even within the workspace', async () => {
    await expect(checkDshMutation('file.txt', { ...policy, mode: 'read-only' }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
  });

  it('permits explicit danger-full-access without applying the fence', async () => {
    const file = join(outside, 'allowed');
    expect(await checkDshMutation(file, { ...policy, mode: 'danger-full-access' })).toBe(file);
  });

  it('denies an outside path and a lexically similar sibling', async () => {
    await expect(checkDshMutation(join(outside, 'file'), policy))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    await expect(checkDshMutation(`${workspace}-sibling/file`, policy))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
  });

  it('allows physical extra roots and documented platform temp areas', async () => {
    expect(await checkDshMutation(join(outside, 'file'), { ...policy, additionalWritableRoots: [outside] }))
      .toBe(join(outside, 'file'));
    const temp = await realpath(tmpdir());
    expect(await checkDshMutation(join(temp, 'omni-dsh-check-only'), policy))
      .toBe(join(temp, 'omni-dsh-check-only'));
  });

  it('rejects missing, non-directory, and symlinked grants', async () => {
    const file = join(fixture, 'file');
    await writeFile(file, 'fixture');
    const alias = join(fixture, 'alias');
    await symlink(outside, alias);
    for (const root of [join(fixture, 'missing'), file, alias]) {
      await expect(checkDshMutation('file', { ...policy, additionalWritableRoots: [root] }))
        .rejects.toMatchObject({ code: 'SANDBOX_INVALID_ROOT' });
    }
  });

  it('rejects workspace aliases and relative roots instead of granting redirected paths', async () => {
    const alias = join(fixture, 'alias');
    await symlink(workspace, alias);
    for (const root of [alias, 'relative']) {
      await expect(checkDshMutation('file', { ...policy, workspaceRoot: root }))
        .rejects.toMatchObject({ code: 'SANDBOX_INVALID_ROOT' });
    }
  });

  it('re-resolves symlink ancestors and denies an escape', async () => {
    await symlink(outside, join(workspace, 'redirect'));
    await expect(checkDshMutation('redirect/new/file', policy))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
  });

  it('resolves dot-dot physically after symlinks and refuses missing-prefix traversal', async () => {
    await mkdir(join(outside, 'nested'));
    await symlink(join(outside, 'nested'), join(workspace, 'redirect'));
    await expect(checkDshMutation('redirect/../file', policy))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    await expect(checkDshMutation('absent/../file', policy)).rejects.toThrow();
  });

  it('fails closed on dangling links, symlink loops and non-directory ancestors', async () => {
    await symlink(join(outside, 'missing'), join(workspace, 'dangling'));
    await symlink('loop', join(workspace, 'loop'));
    await writeFile(join(workspace, 'file'), 'fixture');
    for (const path of ['dangling', 'loop', 'file/child']) {
      await expect(checkDshMutation(path, policy)).rejects.toThrow();
    }
  });

  it('resolves nested symlink targets with native filesystem parent traversal', async () => {
    await mkdir(join(outside, 'sub'));
    await writeFile(join(outside, 'innocent'), 'outside');
    await writeFile(join(workspace, 'innocent'), 'inside');
    await symlink(join(outside, 'sub'), join(workspace, 'portal'));
    await symlink(`${workspace}/portal/../innocent`, join(workspace, 'nested-link'));
    await expect(checkDshMutation('nested-link', policy))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    expect(await readFile(join(outside, 'innocent'), 'utf8')).toBe('outside');
  });

  it('refuses existing multiply-linked files to avoid writing an outside hard-link alias', async () => {
    const target = join(outside, 'shared');
    await writeFile(target, 'unchanged');
    await link(target, join(workspace, 'shared'));
    await expect(checkDshMutation('shared', policy)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    expect(await readFile(target, 'utf8')).toBe('unchanged');
  });

  it('checks both endpoints of a move before returning either', async () => {
    await expect(checkDshMutations(['source', join(outside, 'destination')], policy))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' });
    expect(await checkDshMutations(['source', 'destination'], policy))
      .toEqual([join(workspace, 'source'), join(workspace, 'destination')]);
  });
});
