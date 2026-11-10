import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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
const MAX_DIRECTORY_ENTRIES = 5000;

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

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory';
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
