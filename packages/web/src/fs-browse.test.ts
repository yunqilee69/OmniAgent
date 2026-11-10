import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { browseDirectories, DirectoryBrowseError, expandUserPath } from './fs-browse';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Temp directories live behind symlinks on macOS, so every fixture is canonicalized. */
async function fixture(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'omniagent-fs-browse-'));
  directories.push(created);
  const root = await realpath(created);
  await mkdir(join(root, 'alpha'));
  await mkdir(join(root, 'Beta'));
  await mkdir(join(root, '.hidden'));
  await writeFile(join(root, 'notes.txt'), 'not a folder');
  return root;
}

describe('directory browsing for the workspace picker', () => {
  it('lists folders only, sorted, flagged when hidden', async () => {
    const root = await fixture();
    const listing = await browseDirectories(root);
    expect(listing.path).toBe(root);
    expect(listing.entries).toEqual([
      { name: '.hidden', path: join(root, '.hidden'), hidden: true },
      { name: 'alpha', path: join(root, 'alpha'), hidden: false },
      { name: 'Beta', path: join(root, 'Beta'), hidden: false },
    ]);
    expect(listing.truncated).toBe(false);
  });

  it('reports the canonical parent and stops at a filesystem root', async () => {
    const root = await fixture();
    expect((await browseDirectories(join(root, 'alpha'))).parent).toBe(root);
    expect((await browseDirectories('/')).parent).toBeNull();
  });

  it('follows a symlink that points at a folder', async () => {
    const root = await fixture();
    await symlink(join(root, 'alpha'), join(root, 'linked'));
    const listing = await browseDirectories(root);
    expect(listing.entries.map((entry) => entry.name)).toContain('linked');
  });

  it('starts at the home directory and expands a leading tilde', async () => {
    const home = await realpath(homedir());
    expect((await browseDirectories()).path).toBe(home);
    expect(expandUserPath('~')).toBe(home);
    expect(expandUserPath('~/code')).toBe(join(home, 'code'));
    expect(expandUserPath(' /tmp ')).toBe('/tmp');
    expect(expandUserPath('')).toBe(home);
  });

  it('offers only shortcuts that exist on this machine', async () => {
    const listing = await browseDirectories();
    const ids = listing.roots.map((root) => root.id);
    expect(ids).toContain('home');
    expect(ids).toContain('root');
    expect(listing.roots.find((root) => root.id === 'home')?.path).toBe(await realpath(homedir()));
  });

  it('rejects a relative path, a missing folder, and a file', async () => {
    const root = await fixture();
    const cases: Array<[string, number]> = [
      ['relative/path', 400],
      [join(root, 'missing'), 404],
      [join(root, 'notes.txt'), 400],
    ];
    for (const [input, status] of cases) {
      await expect(browseDirectories(input)).rejects.toBeInstanceOf(DirectoryBrowseError);
      await expect(browseDirectories(input)).rejects.toMatchObject({ status });
    }
  });
});
