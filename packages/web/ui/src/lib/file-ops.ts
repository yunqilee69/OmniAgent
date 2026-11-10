/** File operations the workspace tree can perform, with localized failure keys. */
import { authFetch } from './auth.ts';
import { workspaceApiPath } from './wire.ts';

/** Outcome of one file operation: the new path on success, a message key on failure. */
export type FileOperationResult = { ok: true; path: string } | { ok: false; message: string };

function failureFor(status: number): string {
  if (status === 409) return 'A file or folder with that name already exists.';
  if (status === 403) return 'This path is protected.';
  if (status === 404) return 'That file or folder no longer exists.';
  if (status === 400) return 'That name cannot be used.';
  return 'The file operation failed.';
}

async function send(workspaceId: string, suffix: string, init: RequestInit): Promise<Response | undefined> {
  try {
    return await authFetch(workspaceApiPath(workspaceId, suffix), init);
  } catch {
    return undefined;
  }
}

function jsonBody(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

async function readEntryPath(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { entry?: { path?: unknown } };
    return typeof body.entry?.path === 'string' ? body.entry.path : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Rename one entry in place.
 * @param workspaceId - registered workspace id.
 * @param path - current workspace-relative path.
 * @param name - new name, without separators.
 * @returns the new path, or a message key explaining the failure.
 */
export async function renameWorkspaceFile(workspaceId: string, path: string, name: string): Promise<FileOperationResult> {
  const response = await send(workspaceId, 'files/rename', jsonBody({ path, name }));
  if (response === undefined) return { ok: false, message: 'The file operation failed.' };
  if (!response.ok) return { ok: false, message: failureFor(response.status) };
  return { ok: true, path: await readEntryPath(response, path) };
}

/**
 * Move one entry into another workspace folder.
 * @param workspaceId - registered workspace id.
 * @param path - current workspace-relative path.
 * @param directory - destination folder; '' for the workspace root.
 * @returns the new path, or a message key explaining the failure.
 */
export async function moveWorkspaceFile(workspaceId: string, path: string, directory: string): Promise<FileOperationResult> {
  const response = await send(workspaceId, 'files/move', jsonBody({ path, directory }));
  if (response === undefined) return { ok: false, message: 'The file operation failed.' };
  if (!response.ok) return { ok: false, message: failureFor(response.status) };
  const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return { ok: true, path: await readEntryPath(response, directory === '' ? name : `${directory}/${name}`) };
}

/**
 * Delete one entry, recursively for a folder.
 * @param workspaceId - registered workspace id.
 * @param path - workspace-relative path.
 * @returns whether the entry is gone, with a message key on failure.
 */
export async function deleteWorkspaceFile(workspaceId: string, path: string): Promise<FileOperationResult> {
  const query = new URLSearchParams({ path });
  const response = await send(workspaceId, `files?${query.toString()}`, { method: 'DELETE' });
  if (response === undefined) return { ok: false, message: 'The file operation failed.' };
  if (!response.ok) return { ok: false, message: failureFor(response.status) };
  return { ok: true, path };
}

/**
 * Absolute path of one workspace entry, for the copy action.
 * @param workspacePath - absolute workspace root as registered.
 * @param path - workspace-relative path.
 */
export function absoluteWorkspacePath(workspacePath: string, path: string): string {
  if (workspacePath === '') return path;
  const root = workspacePath.endsWith('/') ? workspacePath.slice(0, -1) : workspacePath;
  return `${root}/${path}`;
}
