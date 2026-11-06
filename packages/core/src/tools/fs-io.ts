import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { TextDecoder } from 'node:util';

/**
 * Local filesystem mechanics ported from DSH's `fs-local`/`tool-fs` packages:
 * bounded UTF-8 decoding, line-ending-preserving literal edits, and atomic
 * publication through an owner-only staging directory.
 *
 * These helpers know nothing about the model-facing tool schema or the DSH
 * permission fence. Callers resolve and authorize the target first, then use
 * the returned path immediately.
 */

/** Bytes scanned for an embedded NUL before treating a file as binary. */
const BINARY_SAMPLE_BYTES = 8_192;

/** Read chunk size used only by the diff-basis fallback. */
const DIFF_BASIS_READ_CHUNK_BYTES = 64 * 1_024;

export type LineEndings = 'LF' | 'CRLF';

export interface EditOutcome {
  replacements: number;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isEnoent(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function isEnotdir(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOTDIR';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function throwIfAborted(signal: AbortSignal | undefined, verb: string): void {
  if (signal?.aborted) throw abortError(verb);
}

function abortError(verb: string): Error {
  return new Error(`${verb} aborted`);
}

/** Stat a regular file, mapping absence and non-file targets to readable errors. */
export async function statRegularFile(path: string, displayPath: string, verb: string): Promise<Stats> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch (error: unknown) {
    if (isEnoent(error) || isEnotdir(error)) throw new Error(`cannot ${verb} "${displayPath}": not found`);
    throw error;
  }
  if (!info.isFile()) throw new Error(`cannot ${verb} "${displayPath}": not a regular file`);
  return info;
}

function decodeUtf8(buffer: Uint8Array, displayPath: string, verb: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    throw new Error(`cannot ${verb} "${displayPath}": invalid UTF-8 text`);
  }
}

function decodeChunk(decoder: TextDecoder, chunk: Uint8Array | undefined, displayPath: string, verb: string): string {
  try {
    return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    throw new Error(`cannot ${verb} "${displayPath}": invalid UTF-8 text`);
  }
}

/** Read a whole regular UTF-8 file, rejecting binary NUL samples and invalid UTF-8. */
export async function readWholeText(path: string, displayPath: string, signal?: AbortSignal): Promise<string> {
  await statRegularFile(path, displayPath, 'read');
  throwIfAborted(signal, 'read');
  let raw: Buffer;
  try {
    raw = await readFile(path, signal ? { signal } : {});
  } catch (error: unknown) {
    if (isAbortError(error)) throw abortError('read');
    throw error;
  }
  throwIfAborted(signal, 'read');
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new Error(`cannot read "${displayPath}": binary file`);
  }
  return decodeUtf8(raw, displayPath, 'read');
}

/** Stream a regular UTF-8 file as decoded chunks without buffering it all. */
export async function* streamWholeText(
  path: string,
  displayPath: string,
  signal?: AbortSignal,
): AsyncIterable<string> {
  await statRegularFile(path, displayPath, 'read');
  const stream = createReadStream(path, signal ? { signal } : {});
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let sampled = 0;

  function scanBinary(chunk: Buffer): void {
    if (sampled >= BINARY_SAMPLE_BYTES) return;
    const sample = chunk.subarray(0, Math.min(chunk.length, BINARY_SAMPLE_BYTES - sampled));
    if (sample.includes(0)) throw new Error(`cannot read "${displayPath}": binary file`);
    sampled += sample.length;
  }

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      scanBinary(chunk);
      yield decodeChunk(decoder, chunk, displayPath, 'read');
    }
    yield decodeChunk(decoder, undefined, displayPath, 'read');
  } catch (error: unknown) {
    if (isAbortError(error)) throw abortError('read');
    throw error;
  }
}

/** CRLF → LF; the canonical in-memory form for edit matching and diffs. */
export function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n');
}

function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4_096);
  const crlfCount = sample.split('\r\n').length - 1;
  const lfCount = sample.split('\n').length - 1 - crlfCount;
  return crlfCount > lfCount ? 'CRLF' : 'LF';
}

function restoreLineEndings(content: string, endings: LineEndings): string {
  return endings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n');
}

/** Read and decode a file for editing, preserving its original line-ending style. */
export async function readForEdit(
  path: string,
  displayPath: string,
  signal?: AbortSignal,
): Promise<{ content: string; lineEndings: LineEndings }> {
  throwIfAborted(signal, 'edit');
  let buffer: Buffer;
  try {
    buffer = await readFile(path, signal ? { signal } : {});
  } catch (error: unknown) {
    if (isAbortError(error)) throw abortError('edit');
    throw error;
  }
  throwIfAborted(signal, 'edit');
  if (buffer.includes(0)) throw new Error(`cannot edit "${displayPath}": binary file`);
  const raw = decodeUtf8(buffer, displayPath, 'edit');
  return { content: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw) };
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const found = content.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

/** Apply DSH's literal edit rule: empty/missing text fails, ambiguity fails unless replace_all. */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number } {
  const oldNorm = normalizeLineEndings(oldString);
  if (oldNorm.length === 0) throw new Error('old_string must be a non-empty string');
  const newNorm = normalizeLineEndings(newString);
  const replacements = countOccurrences(content, oldNorm);
  if (replacements === 0) throw new Error(`old_string was not found in "${displayPath}"`);
  if (!replaceAll && replacements > 1) {
    throw new Error(
      `old_string matched ${replacements} times in "${displayPath}"; `
      + 'provide a more specific old_string or set replace_all to true',
    );
  }
  return { content: content.split(oldNorm).join(newNorm), replacements };
}

/**
 * Best-effort bounded read of the previous content. A binary, invalid UTF-8,
 * oversized, or unreadable file only loses the presentation diff; it never
 * blocks the committed write.
 */
async function readTextForDiff(path: string, maxBytes: number, signal?: AbortSignal): Promise<string | null> {
  throwIfAborted(signal, 'read');
  let handle;
  let total = 0;
  let openedSize = 0;
  let buffer: Buffer;
  try {
    handle = await open(path, 'r');
    try {
      throwIfAborted(signal, 'read');
      const info = await handle.stat();
      throwIfAborted(signal, 'read');
      if (!info.isFile() || info.size >= maxBytes) return null;
      openedSize = info.size;
      buffer = Buffer.allocUnsafe(openedSize + 1);
      while (total < buffer.length) {
        throwIfAborted(signal, 'read');
        const length = Math.min(buffer.length - total, DIFF_BASIS_READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, total, length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (isAbortError(error)) throw abortError('read');
    if (isNodeError(error)) return null;
    throw error;
  }
  throwIfAborted(signal, 'read');
  if (total !== openedSize) return null;
  const basis = buffer.subarray(0, total);
  if (basis.includes(0)) return null;
  try {
    return normalizeLineEndings(new TextDecoder('utf-8', { fatal: true }).decode(basis));
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    return null;
  }
}

/**
 * Per-target in-process serialization, matching DSH's read→match→write lock
 * for edits. It does not coordinate with other processes.
 */
const locks = new Map<string, Promise<unknown>>();

async function withPathLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}

export interface WriteOutcome {
  operation: 'create' | 'update';
}

/**
 * Atomically create or replace a UTF-8 file. The staging file is owner-only,
 * fsynced, and renamed into place; an existing file keeps its mode.
 */
export async function writeTextFile(
  path: string,
  displayPath: string,
  content: string,
  signal?: AbortSignal,
): Promise<WriteOutcome> {
  return withPathLock(path, async () => {
    throwIfAborted(signal, 'write');
    let existing: Stats | undefined;
    try {
      existing = await stat(path);
    } catch (error: unknown) {
      if (!isEnoent(error) && !isEnotdir(error)) throw error;
    }
    if (existing !== undefined && !existing.isFile()) {
      throw new Error(`cannot write "${displayPath}": not a regular file`);
    }
    await atomicReplace(path, displayPath, content, existing?.mode, signal);
    return { operation: existing === undefined ? 'create' : 'update' };
  });
}

/** Edit an existing UTF-8 file under the per-target lock, preserving line endings. */
export async function editTextFile(
  path: string,
  displayPath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  signal?: AbortSignal,
): Promise<EditOutcome> {
  return withPathLock(path, async () => {
    await statRegularFile(path, displayPath, 'edit');
    const original = await readForEdit(path, displayPath, signal);
    const edited = applyLiteralEdit(original.content, oldString, newString, replaceAll, displayPath);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`cannot edit "${displayPath}": not a regular file`);
    await atomicReplace(
      path,
      displayPath,
      restoreLineEndings(edited.content, original.lineEndings),
      info.mode,
      signal,
    );
    return { replacements: edited.replacements };
  });
}

async function atomicReplace(
  path: string,
  displayPath: string,
  content: string,
  mode: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal, 'write');
  const directory = dirname(path);
  try {
    await mkdir(directory, { recursive: true });
  } catch (error: unknown) {
    throw new Error(`cannot write "${displayPath}": ${messageOf(error)}`);
  }

  throwIfAborted(signal, 'write');
  const stagingDir = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmpdir`);
  const tempPath = join(stagingDir, `${basename(path)}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let stagingCreated = false;
  try {
    await mkdir(stagingDir, { mode: 0o700 });
    stagingCreated = true;
    await chmod(stagingDir, 0o700);

    handle = await open(tempPath, 'wx', 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(content, { encoding: 'utf8', ...(signal ? { signal } : {}) });
    await handle.sync();
    if (mode !== undefined) await handle.chmod(mode);
    await handle.close();
    handle = undefined;

    throwIfAborted(signal, 'write');
    await rename(tempPath, path);
    try {
      await rm(stagingDir, { recursive: true, force: true });
    } catch {
      // The target is committed; owner-only staging residue cannot fail the write.
    }
  } catch (error: unknown) {
    if (handle) await handle.close().catch(() => undefined);
    if (stagingCreated) await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    if (isAbortError(error)) throw abortError('write');
    throw new Error(`cannot write "${displayPath}": ${messageOf(error)}`);
  }
}
