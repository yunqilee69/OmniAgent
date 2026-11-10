import { lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Workspace-scoped file references for the composer `@` menu. The scan is
 * bounded, skips dependency/build trees, and never follows symlinks.
 */
const EXCLUDED_DIRS = new Set([
  '.git', '.omniagent', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target',
  '.next', '.nuxt', '.turbo', '.venv', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.gradle',
]);
const MAX_ENTRIES = 50_000;
export const MAX_PREVIEW_BYTES = 1024 * 1024;
/** Raw byte route ceiling: large enough for video and print-ready PDF, streamed rather than buffered. */
export const MAX_RAW_FILE_BYTES = 256 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 5000;
/** Trees a file operation must never touch: repository metadata and this host's own state. */
const PROTECTED_SEGMENTS = new Set(['.git', '.omniagent']);

/**
 * Extensions the raw byte route may serve inline. The value is the exact
 * `content-type` sent; anything absent is download-only `application/octet-stream`.
 * `text/html` is deliberately absent: the route must never become an XSS origin.
 */
export const RAW_CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
};

/** One file resolved for the raw byte route. */
export interface WorkspaceRawFile {
  /** Absolute path already verified to sit inside the workspace root. */
  absolute: string;
  size: number;
  /** Whitelisted type, or `application/octet-stream` when the extension is not inline-safe. */
  contentType: string;
  /** Whether the response may be displayed by the browser rather than downloaded. */
  inline: boolean;
}

function lowercaseExtension(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash ? path.slice(dot + 1).toLowerCase() : '';
}

export class WorkspaceFileError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

async function safeWorkspacePath(root: string, path: string, allowRoot = false): Promise<string> {
  if ((!allowRoot && path === '') || path.length > 1024 || path.includes('\0') || path.includes('\\') ||
      isAbsolute(path) || path.split('/').some((part) => part === '..' || part === '.' || (part === '' && path !== ''))) {
    throw new WorkspaceFileError(400, 'Invalid workspace path');
  }
  let current: string;
  try {
    const base = await realpath(root);
    current = base;
    for (const part of path === '' ? [] : path.split('/')) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new WorkspaceFileError(403, 'Symlinks are not supported');
    }
    if (!(await inside(base, current))) throw new WorkspaceFileError(403, 'Path outside workspace');
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    throw new WorkspaceFileError(404, 'File or directory not found');
  }
  return current;
}

export async function browseWorkspaceDirectory(root: string, path: string): Promise<{ entries: WorkspaceFileEntry[]; truncated: boolean }> {
  const directory = await safeWorkspacePath(root, path, true);
  let entries;
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
    if (process.platform === 'linux') {
      const descriptor = `/proc/self/fd/${handle.fd}`;
      if (!(await inside(root, descriptor))) throw new WorkspaceFileError(403, 'Path outside workspace');
      entries = await readdir(descriptor, { withFileTypes: true });
    } else {
      entries = await readdir(directory, { withFileTypes: true });
    }
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    throw new WorkspaceFileError(404, 'Directory not found');
  } finally { await handle?.close(); }
  const result = entries.filter((entry) => entry.isFile() || entry.isDirectory())
    .map((entry): WorkspaceFileEntry => ({
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      name: entry.name,
      kind: entry.isDirectory() ? 'directory' : 'file',
    }))
    .sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'directory' ? -1 : 1);
  return { entries: result.slice(0, MAX_DIRECTORY_ENTRIES), truncated: result.length > MAX_DIRECTORY_ENTRIES };
}

export async function readWorkspaceFile(root: string, path: string): Promise<string> {
  const target = await safeWorkspacePath(root, path);
  let file;
  try { file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch { throw new WorkspaceFileError(404, 'File not found'); }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new WorkspaceFileError(400, 'Not a regular file');
    if (info.size > MAX_PREVIEW_BYTES) throw new WorkspaceFileError(413, 'File is too large to preview');
    // Verify the opened descriptor on Linux if a parent directory was replaced.
    if (process.platform === 'linux' && !(await inside(root, `/proc/self/fd/${file.fd}`))) {
      throw new WorkspaceFileError(403, 'Path outside workspace');
    }
    const buffer = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_PREVIEW_BYTES) throw new WorkspaceFileError(413, 'File is too large to preview');
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) throw new WorkspaceFileError(415, 'Binary files cannot be previewed');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new WorkspaceFileError(415, 'Binary files cannot be previewed'); }
  } finally { await file.close(); }
}

function assertEditablePath(path: string): void {
  if (path.split('/').some((segment) => PROTECTED_SEGMENTS.has(segment))) {
    throw new WorkspaceFileError(403, 'This path is protected');
  }
}

function assertEntryName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === '..' || trimmed.length > 255
    || trimmed.includes('/') || trimmed.includes('\\') || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new WorkspaceFileError(400, 'Invalid file name');
  }
  return trimmed;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

async function describeEntry(root: string, path: string): Promise<WorkspaceFileEntry> {
  const target = await safeWorkspacePath(root, path);
  let info;
  try { info = await lstat(target); } catch { throw new WorkspaceFileError(404, 'File or directory not found'); }
  return { path, name: basename(path), kind: info.isDirectory() ? 'directory' : 'file' };
}

/**
 * Move or rename one entry, keeping both ends inside the workspace fence.
 * @param root - workspace root.
 * @param from - existing workspace-relative path.
 * @param to - destination workspace-relative path.
 * @returns the entry at its new path.
 */
async function relocate(root: string, from: string, to: string): Promise<WorkspaceFileEntry> {
  if (to === from) return describeEntry(root, from);
  const source = await safeWorkspacePath(root, from);
  const directory = parentOf(to);
  const parent = await safeWorkspacePath(root, directory, true);
  let parentInfo;
  try { parentInfo = await lstat(parent); } catch { throw new WorkspaceFileError(404, 'Target folder not found'); }
  if (!parentInfo.isDirectory()) throw new WorkspaceFileError(400, 'Target is not a folder');
  const destination = join(parent, basename(to));
  let exists = true;
  try { await lstat(destination); } catch { exists = false; }
  if (exists) throw new WorkspaceFileError(409, 'A file or folder with that name already exists');
  try {
    await rename(source, destination);
  } catch {
    throw new WorkspaceFileError(409, 'The file could not be moved');
  }
  return describeEntry(root, to);
}

/**
 * Rename one file or folder in place.
 * @param root - workspace root.
 * @param path - existing workspace-relative path.
 * @param name - new name; path separators and control characters are rejected.
 * @returns the renamed entry.
 */
export async function renameWorkspaceEntry(root: string, path: string, name: string): Promise<WorkspaceFileEntry> {
  assertEditablePath(path);
  await safeWorkspacePath(root, path);
  const directory = parentOf(path);
  const nextName = assertEntryName(name);
  const target = directory === '' ? nextName : `${directory}/${nextName}`;
  assertEditablePath(target);
  return relocate(root, path, target);
}

/**
 * Move one file or folder into another folder of the workspace.
 * @param root - workspace root.
 * @param path - existing workspace-relative path.
 * @param directory - destination folder; '' moves to the workspace root.
 * @returns the entry at its new path.
 */
export async function moveWorkspaceEntry(root: string, path: string, directory: string): Promise<WorkspaceFileEntry> {
  assertEditablePath(path);
  await safeWorkspacePath(root, path);
  if (directory === path || directory.startsWith(`${path}/`)) {
    throw new WorkspaceFileError(400, 'A folder cannot be moved inside itself');
  }
  if (directory !== '') await safeWorkspacePath(root, directory);
  const target = directory === '' ? basename(path) : `${directory}/${basename(path)}`;
  assertEditablePath(target);
  return relocate(root, path, target);
}

/**
 * Delete one file or folder, recursively for folders.
 * @param root - workspace root.
 * @param path - existing workspace-relative path.
 */
export async function removeWorkspaceEntry(root: string, path: string): Promise<void> {
  assertEditablePath(path);
  const target = await safeWorkspacePath(root, path);
  try {
    await rm(target, { recursive: true, force: false });
  } catch {
    throw new WorkspaceFileError(409, 'The file could not be deleted');
  }
}

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory';
}

/**
 * Resolve one file for the raw byte route: the same path fence as
 * {@link readWorkspaceFile}, plus the content type the browser may display.
 * Bytes are streamed by the caller, so this never reads the file.
 */
export async function statWorkspaceRawFile(root: string, path: string): Promise<WorkspaceRawFile> {
  const target = await safeWorkspacePath(root, path);
  let info;
  try { info = await lstat(target); } catch { throw new WorkspaceFileError(404, 'File not found'); }
  if (info.isSymbolicLink()) throw new WorkspaceFileError(403, 'Symlinks are not supported');
  if (!info.isFile()) throw new WorkspaceFileError(400, 'Not a regular file');
  if (info.size > MAX_RAW_FILE_BYTES) throw new WorkspaceFileError(413, 'File is too large to preview');
  const contentType = RAW_CONTENT_TYPES[lowercaseExtension(path)];
  return {
    absolute: target,
    size: info.size,
    contentType: contentType ?? 'application/octet-stream',
    inline: contentType !== undefined,
  };
}

interface Candidate extends WorkspaceFileEntry {
  score: number;
}

function normalized(path: string): string {
  return path.split(sep).join('/');
}

function fuzzyScore(path: string, name: string, needle: string): number {
  const lowerName = name.toLowerCase();
  const lowerPath = path.toLowerCase();
  if (lowerName.startsWith(needle)) return 0;
  if (lowerName.includes(needle)) return 1;
  if (lowerPath.includes(needle)) return 2;
  let cursor = 0;
  for (const character of lowerName) {
    if (character === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return 3;
  }
  return -1;
}

async function inside(root: string, target: string): Promise<boolean> {
  try {
    const actual = await realpath(target);
    const base = await realpath(root);
    return actual === base || actual.startsWith(`${base}${sep}`);
  } catch {
    return false;
  }
}

/** Immediate children of one directory, as composer reference entries. */
async function listDirectory(root: string, directory: string, prefix: string): Promise<WorkspaceFileEntry[]> {
  if (directory.split('/').some((segment) => EXCLUDED_DIRS.has(segment))) return [];
  const absolute = resolve(root, directory);
  if (!(await inside(root, absolute))) return [];
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .filter((entry) => !entry.isDirectory() || !EXCLUDED_DIRS.has(entry.name))
    .map((entry): WorkspaceFileEntry => ({
      path: normalized(prefix === '' ? entry.name : `${prefix}/${entry.name}`),
      name: entry.name,
      kind: entry.isDirectory() ? 'directory' : 'file',
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

async function collect(
  root: string,
  directory: string,
  prefix: string,
  needle: string,
  candidates: Candidate[],
  budget: { remaining: number },
): Promise<void> {
  if (budget.remaining <= 0) return;
  const absolute = directory === '' ? root : resolve(root, directory);
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (budget.remaining-- <= 0) return;
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      candidates.push({ path, name: entry.name, kind: 'directory', score: fuzzyScore(path, entry.name, needle) });
      await collect(root, path, path, needle, candidates, budget);
    } else if (entry.isFile()) {
      candidates.push({ path, name: entry.name, kind: 'file', score: fuzzyScore(path, entry.name, needle) });
    }
  }
}

export async function searchWorkspaceFiles(
  root: string,
  rawQuery: string,
  limit = 20,
): Promise<WorkspaceFileEntry[]> {
  const query = rawQuery.replaceAll('\\', '/').replace(/^\/+/, '');
  const slash = query.lastIndexOf('/');
  const directory = slash === -1 ? '' : query.slice(0, slash);
  const needle = (slash === -1 ? query : query.slice(slash + 1)).toLowerCase();
  const boundedLimit = Math.min(50, Math.max(1, Math.trunc(limit)));

  // A trailing slash (or a directory-only reference) opens the next level so
  // users can walk the tree with repeated @ selections.
  if (needle === '') {
    return (await listDirectory(root, directory, directory)).slice(0, boundedLimit);
  }

  const candidates: Candidate[] = [];
  await collect(root, '', '', needle, candidates, { remaining: MAX_ENTRIES });
  return candidates
    .filter((entry) => entry.score >= 0)
    .sort((left, right) =>
      left.score - right.score
      || (left.kind === right.kind ? 0 : left.kind === 'directory' ? -1 : 1)
      || left.path.length - right.path.length
      || left.path.localeCompare(right.path))
    .slice(0, boundedLimit)
    .map(({ path, name, kind }) => ({ path, name, kind }));
}

/** URL-safe route guard: the query is user supplied and never a path. */
export function isWorkspaceRelativeReference(value: string): boolean {
  return value !== '' && value.length <= 1_024 && !isAbsolute(value) &&
    !value.split('/').includes('..') && !value.includes('\0');
}

export function relativeToWorkspace(root: string, path: string): string | undefined {
  const value = relative(root, path);
  return value === '' || value.startsWith('..') || isAbsolute(value) ? undefined : normalized(value);
}
