import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  absoluteWorkspacePath, deleteWorkspaceFile, moveWorkspaceFile, renameWorkspaceFile,
} from '../ui/src/lib/file-ops.ts';

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(response: Response | Error): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('workspace file operations', () => {
  it('renames through the workspace route and returns the new path', async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify({ entry: { path: 'docs/manual.md' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    expect(await renameWorkspaceFile('ws', 'docs/guide.md', 'manual.md'))
      .toEqual({ ok: true, path: 'docs/manual.md' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/workspaces/ws/files/rename');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ path: 'docs/guide.md', name: 'manual.md' });
  });

  it('moves into a folder and falls back to the expected path', async () => {
    stubFetch(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await moveWorkspaceFile('ws', 'docs/guide.md', 'docs/archive'))
      .toEqual({ ok: true, path: 'docs/archive/guide.md' });
    stubFetch(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await moveWorkspaceFile('ws', 'docs/guide.md', '')).toEqual({ ok: true, path: 'guide.md' });
  });

  it('deletes through a query parameter', async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify({ removed: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    expect(await deleteWorkspaceFile('ws', 'docs/guide.md')).toEqual({ ok: true, path: 'docs/guide.md' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/workspaces/ws/files?path=docs%2Fguide.md');
    expect(init.method).toBe('DELETE');
  });

  it('maps failures to message keys', async () => {
    stubFetch(new Response('{"error":"conflict"}', { status: 409 }));
    expect(await renameWorkspaceFile('ws', 'a.md', 'b.md'))
      .toEqual({ ok: false, message: 'A file or folder with that name already exists.' });
    stubFetch(new Response('{"error":"protected"}', { status: 403 }));
    expect(await deleteWorkspaceFile('ws', '.git/config'))
      .toEqual({ ok: false, message: 'This path is protected.' });
    stubFetch(new Response('{"error":"gone"}', { status: 404 }));
    expect(await moveWorkspaceFile('ws', 'a.md', 'docs'))
      .toEqual({ ok: false, message: 'That file or folder no longer exists.' });
    stubFetch(new TypeError('offline'));
    expect(await deleteWorkspaceFile('ws', 'a.md'))
      .toEqual({ ok: false, message: 'The file operation failed.' });
  });

  it('joins absolute paths for the copy action', () => {
    expect(absoluteWorkspacePath('/Users/me/project', 'docs/guide.md')).toBe('/Users/me/project/docs/guide.md');
    expect(absoluteWorkspacePath('/Users/me/project/', 'guide.md')).toBe('/Users/me/project/guide.md');
    expect(absoluteWorkspacePath('', 'guide.md')).toBe('guide.md');
  });
});
