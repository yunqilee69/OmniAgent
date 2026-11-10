import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAttachmentBatch, readAttachment } from './attachment-storage';

const supported = (process.platform === 'linux' || process.platform === 'darwin') && process.getuid !== undefined;
const isInside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

afterEach(() => vi.unstubAllEnvs());

describe.runIf(supported)('attachment storage temporary roots', () => {
  it('refuses the /var/tmp fallback when it is the configured temporary root', async () => {
    vi.stubEnv('TMPDIR', '/var/tmp');
    const home = await realpath(homedir());
    await expect(createAttachmentBatch(home, home)).rejects.toThrow(/No safe attachment storage/);
  });

  it('resolves a temporary-root symlink before selecting the fallback', async () => {
    const temp = await realpath(await mkdtemp('/tmp/attachment-root-'));
    const home = await realpath(homedir());
    const alias = join(temp, 'home-link');
    try {
      await symlink(home, alias);
      vi.stubEnv('TMPDIR', alias);
      const batch = await createAttachmentBatch(temp, temp);
      try {
        expect(isInside(home, batch.path)).toBe(false);
        expect(isInside(await realpath('/var/tmp'), batch.path)).toBe(true);
      } finally { await batch.finish(false); }
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it('refuses the fallback when a temporary-root symlink resolves to /var/tmp', async () => {
    const temp = await realpath(await mkdtemp('/tmp/attachment-root-'));
    try {
      const alias = join(temp, 'var-tmp');
      await symlink('/var/tmp', alias);
      vi.stubEnv('TMPDIR', alias);
      const home = await realpath(homedir());
      await expect(createAttachmentBatch(home, home)).rejects.toThrow(/No safe attachment storage/);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it('fails closed for a filesystem-root temporary directory or an unresolved temporary directory', async () => {
    const home = await realpath(homedir());
    vi.stubEnv('TMPDIR', '/');
    await expect(createAttachmentBatch(home, home)).rejects.toThrow(/No safe attachment storage/);
    vi.stubEnv('TMPDIR', join(home, '.nonexistent-attachment-test', 'missing'));
    await expect(createAttachmentBatch(home, home)).rejects.toThrow();
  });

  it('continues to read an existing attachment after the temporary root changes', async () => {
    vi.stubEnv('TMPDIR', '/tmp');
    const home = await realpath(homedir());
    const batch = await createAttachmentBatch(home, home);
    try {
      const path = await batch.write('0-test', Buffer.from('contents'));
      vi.stubEnv('TMPDIR', dirname(dirname(batch.path)));
      expect((await readAttachment(path))?.toString()).toBe('contents');
    } finally { await batch.finish(false); }
  });
});
