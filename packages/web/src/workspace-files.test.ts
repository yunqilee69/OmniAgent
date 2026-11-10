import { mkdir, mkdtemp, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  browseWorkspaceDirectory, MAX_PREVIEW_BYTES, MAX_RAW_FILE_BYTES, readWorkspaceFile, searchWorkspaceFiles, statWorkspaceRawFile,
} from './workspace-files';

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

describe('workspace file browser', () => {
  it('lists actual directory children and reads UTF-8 text', async () => {
    const root = await workspace();
    const listing = await browseWorkspaceDirectory(root, '');
    expect(listing.entries).toContainEqual({ path: 'node_modules', name: 'node_modules', kind: 'directory' });
    expect((await browseWorkspaceDirectory(root, 'src')).entries.map((entry) => entry.path)).toEqual(['src/lib', 'src/main.ts']);
    expect(await readWorkspaceFile(root, 'README.md')).toBe('# Read me\n');
  });

  it('rejects traversal, absolute paths, and symlinks including internal links', async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), 'omniagent-outside-'));
    await writeFile(join(outside, 'secret'), 'secret');
    await symlink(outside, join(root, 'escape'));
    await symlink(join(root, 'src'), join(root, 'inside-link'));
    for (const path of ['../secret', '/etc/passwd', 'src/../README.md', 'escape/secret', 'inside-link/main.ts', 'src\\main.ts']) {
      await expect(readWorkspaceFile(root, path)).rejects.toBeInstanceOf(Error);
    }
    await expect(browseWorkspaceDirectory(root, 'escape')).rejects.toMatchObject({ status: 403 });
    expect((await browseWorkspaceDirectory(root, '')).entries.some((entry) => entry.path === 'escape')).toBe(false);
  });

  it('rejects binary, invalid UTF-8, large files, and directories', async () => {
    const root = await workspace();
    await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2]));
    await writeFile(join(root, 'invalid'), Buffer.from([0xff]));
    await writeFile(join(root, 'large'), Buffer.alloc(MAX_PREVIEW_BYTES + 1, 65));
    await expect(readWorkspaceFile(root, 'binary')).rejects.toMatchObject({ status: 415 });
    await expect(readWorkspaceFile(root, 'invalid')).rejects.toMatchObject({ status: 415 });
    await expect(readWorkspaceFile(root, 'large')).rejects.toMatchObject({ status: 413 });
    await expect(readWorkspaceFile(root, 'src')).rejects.toMatchObject({ status: 400 });
  });
});

describe('raw workspace file descriptors', () => {
  it('whitelists displayable types and falls back to download-only octet-stream', async () => {
    const root = await workspace();
    await writeFile(join(root, 'cover.PNG'), Buffer.from([1, 2, 3]));
    await writeFile(join(root, 'manual.pdf'), Buffer.from([1, 2, 3]));
    await writeFile(join(root, 'clip.mp4'), Buffer.from([1, 2, 3]));
    await writeFile(join(root, 'page.html'), '<h1>hi</h1>');
    await writeFile(join(root, 'notes.md'), '# hi\n');
    const png = await statWorkspaceRawFile(root, 'cover.PNG');
    expect([png.contentType, png.inline, png.size]).toEqual(['image/png', true, 3]);
    expect((await statWorkspaceRawFile(root, 'manual.pdf')).contentType).toBe('application/pdf');
    expect((await statWorkspaceRawFile(root, 'clip.mp4')).contentType).toBe('video/mp4');
    // HTML must never be served inline: the byte route would become an XSS origin.
    expect(await statWorkspaceRawFile(root, 'page.html')).toMatchObject({
      contentType: 'application/octet-stream', inline: false,
    });
    expect((await statWorkspaceRawFile(root, 'notes.md')).inline).toBe(false);
  });

  it('keeps the same path fence as the text reader', async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), 'omniagent-outside-'));
    await writeFile(join(outside, 'secret.png'), 'secret');
    await symlink(join(outside, 'secret.png'), join(root, 'escape.png'));
    await expect(statWorkspaceRawFile(root, 'missing.png')).rejects.toMatchObject({ status: 404 });
    await expect(statWorkspaceRawFile(root, 'src')).rejects.toMatchObject({ status: 400 });
    await expect(statWorkspaceRawFile(root, 'escape.png')).rejects.toMatchObject({ status: 403 });
    await expect(statWorkspaceRawFile(root, '../secret.png')).rejects.toMatchObject({ status: 400 });
  });

  it('refuses files past the raw ceiling', async () => {
    const root = await workspace();
    await writeFile(join(root, 'huge.mp4'), '');
    await truncate(join(root, 'huge.mp4'), MAX_RAW_FILE_BYTES + 1);
    await expect(statWorkspaceRawFile(root, 'huge.mp4')).rejects.toMatchObject({ status: 413 });
  });
});
