import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

/**
 * Read-only filesystem browsing for the "add workspace" directory picker.
 *
 * The browser UI cannot read absolute paths on its own (the File System Access
 * API exposes handles, not paths), so the host lists directories over HTTP. The
 * picker only ever needs folders, so files are filtered out on this side.
 */

/** One selectable folder inside a listing. */
export interface DirectoryEntry {
  /** Folder name, as shown in the list. */
  name: string;
  /** Absolute path of the folder. */
  path: string;
  /** Dot-prefixed folders are hidden unless the picker opts in. */
  hidden: boolean;
}

/** A well-known folder offered as a shortcut; the UI translates the `id`. */
export interface DirectoryRoot {
  id: 'home' | 'desktop' | 'documents' | 'downloads' | 'root';
  path: string;
}

/** One directory level, as returned by {@link browseDirectories}. */
export interface DirectoryListing {
  /** Canonical (symlink-free) absolute path that was listed. */
  path: string;
  /** Parent directory, or `null` at a filesystem root. */
  parent: string | null;
  /** Shortcuts that exist on this machine. */
  roots: DirectoryRoot[];
  entries: DirectoryEntry[];
  truncated: boolean;
}

/** Bounded so a huge directory cannot stall the picker. */
export const MAX_DIRECTORY_ENTRIES = 1_000;
/** Longest path accepted from the client. */
const MAX_PATH_LENGTH = 4_096;

export class DirectoryBrowseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'DirectoryBrowseError';
  }
}

function home(): string {
  return resolve(homedir());
}

/** Expand a leading `~` so the picker's "go to folder" field accepts it. */
export function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '' || trimmed === '~') return home();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(home(), trimmed.slice(2));
  }
  return trimmed;
}

async function shortcut(id: DirectoryRoot['id'], path: string): Promise<DirectoryRoot | undefined> {
  try {
    return (await stat(path)).isDirectory() ? { id, path } : undefined;
  } catch {
    return undefined;
  }
}

async function roots(): Promise<DirectoryRoot[]> {
  const base = home();
  const candidates = await Promise.all([
    shortcut('home', base),
    shortcut('desktop', join(base, 'Desktop')),
    shortcut('documents', join(base, 'Documents')),
    shortcut('downloads', join(base, 'Downloads')),
    shortcut('root', parse(base).root),
  ]);
  return candidates.filter((entry): entry is DirectoryRoot => entry !== undefined);
}

/**
 * Folders only. Symlinks are probed (a linked folder is a real destination)
 * and so are entries the filesystem would not classify, both bounded.
 */
async function directories(path: string): Promise<{ entries: DirectoryEntry[]; truncated: boolean }> {
  let raw;
  try {
    raw = await readdir(path, { withFileTypes: true });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'EACCES' || code === 'EPERM') throw new DirectoryBrowseError(403, 'The directory cannot be read');
    throw new DirectoryBrowseError(404, 'Directory not found');
  }
  const names: string[] = [];
  const probes: string[] = [];
  for (const entry of raw) {
    if (entry.isDirectory()) names.push(entry.name);
    else if (!entry.isFile()) probes.push(entry.name);
  }
  const linked = await Promise.all(probes.slice(0, MAX_DIRECTORY_ENTRIES).map(async (name) => {
    const child = join(path, name);
    return (await stat(child).then((info) => info.isDirectory(), () => false)) ? name : undefined;
  }));
  for (const name of linked) if (name !== undefined) names.push(name);
  const sorted = names
    .map((name): DirectoryEntry => ({ name, path: join(path, name), hidden: name.startsWith('.') }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
  return { entries: sorted.slice(0, MAX_DIRECTORY_ENTRIES), truncated: sorted.length > MAX_DIRECTORY_ENTRIES };
}

/**
 * List one directory level for the workspace directory picker.
 * @param input - absolute path, a leading `~` is expanded; empty lists the home directory.
 * @returns the canonical path, its parent, existing shortcuts, and child folders.
 */
export async function browseDirectories(input?: string): Promise<DirectoryListing> {
  const requested = expandUserPath(input ?? '');
  if (requested.length > MAX_PATH_LENGTH || requested.includes('\0')) {
    throw new DirectoryBrowseError(400, 'Invalid directory path');
  }
  if (!isAbsolute(requested)) throw new DirectoryBrowseError(400, 'An absolute directory path is required');

  let path: string;
  try {
    path = await realpath(requested);
  } catch {
    throw new DirectoryBrowseError(404, 'Directory not found');
  }
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new DirectoryBrowseError(404, 'Directory not found');
  }
  if (!info.isDirectory()) throw new DirectoryBrowseError(400, 'The path must be a directory');

  const listing = await directories(path);
  const parent = dirname(path);
  return {
    path,
    parent: parent === path ? null : parent,
    roots: await roots(),
    entries: listing.entries,
    truncated: listing.truncated,
  };
}
