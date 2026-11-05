import { lstat, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DshSandboxError } from './dsh-policy';

const MAX_SCANNED_ENTRIES = 100_000;

/**
 * Seatbelt and path-based bind mounts authorize a *path*, not an inode. A
 * pre-existing hard link inside a writable root can therefore alias a file
 * outside it. The file-write fence rejects multiply-linked targets for the
 * built-in write tool; confined shell commands need a preflight because they
 * can issue arbitrary writes that we cannot inspect.
 *
 * This is a mitigation, not an atomic guarantee: a same-user process can add
 * a hard link after the scan. It deliberately fails closed when the tree is
 * too large to verify instead of silently skipping the check.
 */
export async function assertNoHardlinkedFiles(roots: readonly string[]): Promise<void> {
  let scanned = 0;
  for (const supplied of roots) {
    const root = await realpath(supplied);
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      let entries;
      try {
        entries = await opendir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new DshSandboxError('Cannot verify workspace hard-link safety', 'SANDBOX_HARDLINK_CHECK_FAILED', { cause: error });
      }
      try {
        for await (const entry of entries) {
          scanned += 1;
          if (scanned > MAX_SCANNED_ENTRIES) {
            throw new DshSandboxError(
              `Workspace has more than ${MAX_SCANNED_ENTRIES} entries; refusing shell because hard-link safety cannot be verified`,
              'SANDBOX_HARDLINK_CHECK_INCOMPLETE',
            );
          }
          // Do not follow symlinks: paths through them are checked by the
          // sandbox and cannot carry a hard link into the writable tree.
          if (entry.isSymbolicLink()) continue;
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            pending.push(path);
            continue;
          }
          if (!entry.isFile()) continue;
          const info = await lstat(path);
          if (info.nlink > 1) {
            throw new DshSandboxError(
              `Refusing confined shell: writable root contains a hard-linked file (${JSON.stringify(path)}); ` +
              'the sandbox cannot prevent writes through the external alias',
              'SANDBOX_HARDLINK_UNSAFE',
            );
          }
        }
      } finally {
        await entries.close().catch(() => undefined);
      }
    }
  }
}
