import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { dshPhysicalDirectory } from '../sandbox/dsh-policy';

// Durable, owner-only storage. Random batch names act as bearer capabilities: a
// fork can use the recorded absolute path without granting access to its cwd's
// parent or to arbitrary files in the user's home directory.
const BATCH = /^[a-f0-9]{48}$/;
const FILE = /^[0-7]-.+$/u;
const MAX_BYTES = 8 * 1024 * 1024;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function candidates(forWriting = false): Promise<string[]> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return [];
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  // Match the sandbox's physical temp grants; unresolved roots cannot be trusted.
  const temps = forWriting ? await Promise.all(['/tmp', tmpdir()].map((path) => dshPhysicalDirectory(path, false))) : [];
  const result: string[] = [];
  // /tmp is deliberately excluded: Linux bubblewrap may mask it with a tmpfs.
  for (const [parent, name] of [[homedir(), '.omniagent-attachments'], ['/var/tmp', `omniagent-attachments-${uid}`]]) {
    try {
      const physical = await realpath(parent!);
      const info = await lstat(physical);
      if (!info.isDirectory()) throw new Error('expected directory');
      if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) continue;
      if (process.platform === 'linux' && inside('/tmp', physical)) continue;
      const base = join(physical, name!);
      if (temps.some((temp) => inside(temp, base))) continue;
      result.push(base);
    } catch { /* try the next durable location */ }
  }
  return [...new Set(result)];
}

async function hasGitAncestor(path: string): Promise<boolean> {
  for (let current = path; ; current = dirname(current)) {
    try { await lstat(join(current, '.git')); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (dirname(current) === current) return false;
  }
}

async function checkPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error('Attachment directory is not private');
  }
}

/** Select a location outside the workspace, cwd, and any enclosing Git worktree. */
export async function createAttachmentBatch(workspace: string, cwd: string): Promise<{
  path: string;
  write: (name: string, bytes: Buffer) => Promise<string>;
  finish: (keep: boolean) => Promise<void>;
}> {
  const roots = await Promise.all([realpath(workspace), realpath(cwd)]);
  let lastError: unknown;
  for (const base of await candidates(true)) {
    if (roots.some((root) => inside(root, base))) continue;
    try {
      if (await hasGitAncestor(dirname(base))) continue;
      try { await mkdir(base, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await checkPrivateDirectory(base);
      // Reject a symlinked parent or a directory swapped while it was checked.
      if (await realpath(base) !== base || await hasGitAncestor(base)) throw new Error('Unsafe attachment storage location');
      const batch = join(base, randomBytes(24).toString('hex'));
      await mkdir(batch, { mode: 0o700 });
      await checkPrivateDirectory(batch);
      const names: string[] = [];
      return {
        path: batch,
        async write(name, bytes) {
          if (!FILE.test(name) || basename(name) !== name || bytes.length > MAX_BYTES) throw new Error('Invalid attachment file');
          await checkPrivateDirectory(base);
          await checkPrivateDirectory(batch);
          if (await realpath(base) !== base || await realpath(batch) !== batch) throw new Error('Unsafe attachment path');
          const path = join(batch, name);
          const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          names.push(name);
          try { await file.writeFile(bytes); } finally { await file.close(); }
          return path;
        },
        async finish(keep) {
          if (keep) return;
          // Do not follow a replacement symlink during cleanup.
          try {
            await checkPrivateDirectory(base);
            await checkPrivateDirectory(batch);
            if (await realpath(base) !== base || await realpath(batch) !== batch) return;
            for (const name of names) await unlink(join(batch, name)).catch(() => {});
            await rmdir(batch).catch(() => {});
          } catch { /* fail closed; a same-user process may have replaced it */ }
        },
      };
    } catch (error) { lastError = error; }
  }
  throw new Error('No safe attachment storage outside the workspace and Git worktrees is available', { cause: lastError });
}

/** Return undefined for ordinary paths. Never follow symlinks in attachment paths. */
export async function readAttachment(path: string): Promise<Buffer | undefined> {
  if (!isAbsolute(path) || resolve(path) !== path) return undefined;
  const batch = dirname(path);
  const base = dirname(batch);
  if (!(await candidates()).includes(base) || !BATCH.test(basename(batch)) || !FILE.test(basename(path))) return undefined;
  await checkPrivateDirectory(base);
  await checkPrivateDirectory(batch);
  if (await realpath(base) !== base || await realpath(batch) !== batch) throw new Error('Unsafe attachment path');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.nlink !== 1 || info.size > MAX_BYTES) {
      throw new Error('Unsafe attachment file');
    }
    // Bound reads even if a same-user process grows the file after stat.
    const data = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    while (used < data.length) {
      const { bytesRead } = await file.read(data, used, data.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MAX_BYTES) throw new Error('Attachment is too large');
    return data.subarray(0, used);
  } finally { await file.close(); }
}
