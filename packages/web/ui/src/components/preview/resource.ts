/**
 * One load per previewed file: text bodies come from `files/content`, binary
 * bodies from `files/raw`, and media/svg/images point at `files/raw` directly
 * so the browser streams them and can range-seek.
 *
 * A small LRU keeps a file's settled body while the user walks between rows in
 * the file tree; it is bounded by both entry count and byte budget because a
 * PDF body is whole-file work, not a string.
 */
import { useEffect, useState } from 'react';
import { authFetch } from '../../lib/auth.ts';
import { workspaceApiPath } from '../../lib/wire.ts';
import { sourceForPath, type PreviewKind } from './path.ts';

/** Largest body this client will hold for a binary viewer. */
export const MAX_CLIENT_BYTES = 32 * 1024 * 1024;
const CACHE_ENTRIES = 8;
const CACHE_BYTES = 32 * 1024 * 1024;

/** Settled state of one preview resource. */
export type PreviewResource =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'text'; text: string }
  | { status: 'bytes'; bytes: Uint8Array }
  | { status: 'url'; url: string };

interface CacheEntry { resource: PreviewResource; cost: number }

const cache = new Map<string, CacheEntry>();
let cachedBytes = 0;

function readCache(key: string): PreviewResource | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit.resource;
}

function writeCache(key: string, resource: PreviewResource, cost: number): void {
  const existing = cache.get(key);
  if (existing !== undefined) {
    cachedBytes -= existing.cost;
    cache.delete(key);
  }
  // A body larger than the whole budget is never cached; re-reading is cheaper than evicting everything.
  if (cost > CACHE_BYTES) return;
  cache.set(key, { resource, cost });
  cachedBytes += cost;
  while (cache.size > 1 && (cache.size > CACHE_ENTRIES || cachedBytes > CACHE_BYTES)) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    const entry = cache.get(oldest.value);
    if (entry === undefined) break;
    cache.delete(oldest.value);
    cachedBytes -= entry.cost;
  }
}

/** Drop every cached body; exported for tests and for a hard workspace switch. */
export function clearPreviewCache(): void {
  cache.clear();
  cachedBytes = 0;
}

/**
 * Same-origin URL for one workspace file, usable by `<img>`, `<video>`, and
 * "open in new tab" without any fetch: the session cookie rides along.
 * @param workspaceId - registered workspace id.
 * @param path - workspace-relative path.
 * @param options.download - ask the server for an attachment disposition.
 * @param options.load - cache-busting nonce, so a rewritten file shows new bytes.
 */
export function rawFileUrl(workspaceId: string, path: string, options?: { download?: boolean; load?: number }): string {
  const query = new URLSearchParams({ path });
  if (options?.download === true) query.set('download', '1');
  if (options?.load !== undefined) query.set('load', String(options.load));
  return workspaceApiPath(workspaceId, `files/raw?${query.toString()}`);
}

/**
 * Make a same-origin path absolute. The Markdown renderer only accepts absolute
 * image URLs, so relative raw paths must be qualified before they reach it.
 * @param path - same-origin path such as `/api/workspaces/…`.
 * @returns the absolute URL, or the input when no origin is available (SSR, tests).
 */
export function absoluteUrl(path: string): string {
  try {
    return new URL(path, window.location.origin).href;
  } catch {
    return path;
  }
}

function errorMessageFor(status: number): string {
  if (status === 413) return 'File is too large to preview.';
  if (status === 415) return 'Binary files cannot be previewed.';
  if (status === 404) return 'File not found.';
  if (status === 403) return 'This file cannot be opened.';
  return 'Could not load file.';
}

/**
 * Load one preview body for the given kind.
 * @param workspaceId - registered workspace id.
 * @param path - workspace-relative path.
 * @param kind - viewer kind from {@link previewKindFor}.
 * @param attempt - retry counter; changing it re-runs the request.
 * @param load - cache-busting nonce for URL sources.
 * @returns the settled resource, or a loading placeholder.
 */
export function usePreviewResource(
  workspaceId: string,
  path: string,
  kind: PreviewKind,
  attempt: number,
  load = 0,
): PreviewResource {
  const source = sourceForPath(path);
  const cacheKey = `${kind}\0${source === 'url' ? load : 0}\0${workspaceId}\0${path}`;
  const [resource, setResource] = useState<PreviewResource>(() => readCache(cacheKey) ?? { status: 'loading' });

  useEffect(() => {
    if (source === 'none') { setResource({ status: 'none' }); return; }
    const cached = readCache(cacheKey);
    if (cached !== undefined) { setResource(cached); return; }
    if (source === 'url') {
      const settled: PreviewResource = { status: 'url', url: rawFileUrl(workspaceId, path, { load }) };
      writeCache(cacheKey, settled, 0);
      setResource(settled);
      return;
    }
    const controller = new AbortController();
    setResource({ status: 'loading' });
    const query = new URLSearchParams({ path });
    const target = source === 'bytes'
      ? workspaceApiPath(workspaceId, `files/raw?${query.toString()}`)
      : workspaceApiPath(workspaceId, `files/content?${query.toString()}`);
    void authFetch(target, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(errorMessageFor(response.status));
        if (source === 'bytes') {
          const declared = Number(response.headers.get('content-length') ?? '0');
          if (Number.isFinite(declared) && declared > MAX_CLIENT_BYTES) throw new Error('File is too large to preview.');
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > MAX_CLIENT_BYTES) throw new Error('File is too large to preview.');
          const settled: PreviewResource = { status: 'bytes', bytes };
          writeCache(cacheKey, settled, bytes.byteLength);
          return settled;
        }
        const body = await response.json() as { content: string };
        const settled: PreviewResource = { status: 'text', text: body.content };
        writeCache(cacheKey, settled, body.content.length * 2);
        return settled;
      })
      .then((settled) => { if (!controller.signal.aborted) setResource(settled); })
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        setResource({ status: 'error', message: error.message });
      });
    return () => { controller.abort(); };
  }, [cacheKey, source, workspaceId, path, attempt, load]);

  return resource;
}
