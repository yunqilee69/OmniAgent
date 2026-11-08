import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Workspace-scoped file references for the composer `@` menu. The scan is
 * bounded, skips dependency/build trees, and never follows symlinks.
 */
const EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target',
  '.next', '.nuxt', '.turbo', '.venv', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.gradle',
]);
const MAX_ENTRIES = 50_000;

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
