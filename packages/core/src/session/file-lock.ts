import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_INITIAL_MS = 20;
const LOCK_RETRY_MAX_MS = 200;
const INVALID_LOCK_STALE_MS = 60_000;

function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: string }).code
    : undefined;
}

function holderState(record: string): 'alive' | 'dead' | 'unknown' {
  if (!/^\d+\n$/.test(record)) return 'unknown';
  const pid = Number(record.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff || pid === process.pid) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return code(error) === 'ESRCH' ? 'dead' : 'alive';
  }
}

/**
 * Remove a lock only when its recorded holder is provably gone (or its record
 * is torn and old). Rename is the takeover claim: exactly one contender can
 * move that inode, so a fresh lock another contender creates afterwards is
 * never deleted by a loser.
 */
async function takeOverExitedLock(lockPath: string): Promise<boolean> {
  let record: string;
  try {
    record = await readFile(lockPath, 'utf8');
  } catch (error) {
    return code(error) === 'ENOENT';
  }
  let state = holderState(record);
  if (state === 'unknown') {
    try {
      const info = await stat(lockPath);
      if (Date.now() - info.mtimeMs < INVALID_LOCK_STALE_MS) return false;
      state = 'dead';
    } catch (error) {
      return code(error) === 'ENOENT';
    }
  }
  if (state !== 'dead') return false;
  const quarantined = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, quarantined);
  } catch (error) {
    // Another contender claimed the same stale lock first.
    if (code(error) === 'ENOENT') return true;
    throw error;
  }
  await rm(quarantined, { force: true });
  return true;
}

/**
 * Serialize a session read-modify-rename cycle across processes. Readers stay
 * lock-free because commits are atomic renames; writers contend on a sibling
 * `wx` lock that records the holder PID. The lock is taken over only when that
 * PID is gone, so a crashed writer cannot block a session forever.
 */
export async function withSessionLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let delayMs = LOCK_RETRY_INITIAL_MS;
  for (;;) {
    let acquired = false;
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (code(error) !== 'EEXIST' && code(error) !== 'EPERM') throw error;
      if (code(error) === 'EPERM') {
        try {
          await stat(lockPath);
        } catch (probeError) {
          if (code(probeError) !== 'ENOENT') throw error;
        }
      }
    }
    if (handle) {
      try {
        await handle.writeFile(`${process.pid}\n`, 'utf8');
        await handle.sync();
        acquired = true;
      } catch (error) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        await handle.close();
      }
    }
    if (acquired) break;
    if (await takeOverExitedLock(lockPath)) continue;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the session lock at ${lockPath}`);
    await delay(delayMs);
    delayMs = Math.min(delayMs * 2, LOCK_RETRY_MAX_MS);
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { force: true });
  }
}
