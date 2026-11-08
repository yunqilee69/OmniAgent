import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { searchWorkspaceFiles } from './workspace-files';

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-files-'));
  await mkdir(join(root, 'src', 'lib'), { recursive: true });
  await mkdir(join(root, 'docs'));
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'src', 'main.ts'), 'export {};\n');
  await writeFile(join(root, 'src', 'lib', 'util.ts'), 'export const x = 1;\n');
  await writeFile(join(root, 'README.md'), '# Read me\n');
  await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n');
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n');
  return root;
}

describe('workspace file search', () => {
  it('lists root children with directories first and skips dependency trees', async () => {
    const root = await workspace();
    const entries = await searchWorkspaceFiles(root, '', 20);
    expect(entries.map((entry) => [entry.path, entry.kind])).toEqual([
      ['docs', 'directory'],
      ['src', 'directory'],
      ['README.md', 'file'],
    ]);
  });

  it('opens a directory level from a trailing slash', async () => {
    const root = await workspace();
    const entries = await searchWorkspaceFiles(root, 'src/', 20);
    expect(entries.map((entry) => [entry.path, entry.kind])).toEqual([
      ['src/lib', 'directory'],
      ['src/main.ts', 'file'],
    ]);
  });

  it('finds nested files by fuzzy name and keeps directories selectable', async () => {
    const root = await workspace();
    const entries = await searchWorkspaceFiles(root, 'util', 20);
    expect(entries).toContainEqual({ path: 'src/lib/util.ts', name: 'util.ts', kind: 'file' });
    expect(entries.some((entry) => entry.path.startsWith('node_modules'))).toBe(false);
    expect((await searchWorkspaceFiles(root, 'src', 20)).some(
      (entry) => entry.path === 'src' && entry.kind === 'directory',
    )).toBe(true);
  });

  it('does not follow symlinks out of the workspace', async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), 'omniagent-files-outside-'));
    await writeFile(join(outside, 'secret.ts'), 'const secret = true;\n');
    await symlink(outside, join(root, 'escape'));
    const entries = await searchWorkspaceFiles(root, 'secret', 20);
    expect(entries).toEqual([]);
  });

  it('respects the requested result limit', async () => {
    const root = await workspace();
    expect(await searchWorkspaceFiles(root, 's', 2)).toHaveLength(2);
  });
});
