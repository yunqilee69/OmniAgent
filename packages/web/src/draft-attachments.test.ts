import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIndexedDbDraftStore,
  DRAFT_ATTACHMENT_DB_NAME,
  DRAFT_ATTACHMENT_STORE_NAME,
  draftAttachmentBytes,
  draftAttachmentKey,
  draftAttachmentRecord,
  MAX_DRAFT_ATTACHMENT_RECORDS,
  resolveDraftAttachmentStore,
  sanitizeDraftAttachments,
  type DraftAttachment,
  type DraftAttachmentStore,
} from '../ui/src/lib/draft-attachments.ts';
import { composerDraftKey } from '../ui/src/lib/composer-drafts.ts';
import { sessionKey } from '../ui/src/lib/store.ts';
import { MAX_ATTACHMENTS } from '../ui/src/lib/wire.ts';

const MiB = 1024 * 1024;

/**
 * Minimal IndexedDB stand-in: node has no IndexedDB, and the adapter's write / read /
 * prune branches are only covered if the tests can drive `open` → `onsuccess`,
 * `transaction`, `objectStore`, `put`, `get`, `delete` and `getAll` for real.
 *
 * Every request settles on a microtask, like the real thing, and failures are injected
 * through the mutable options so one fake covers the happy path and each error branch.
 */
interface FakeIdbOptions {
  failOpen?: unknown;
  failGet?: unknown;
  failGetAll?: unknown;
  failPut?: unknown;
  failDelete?: unknown;
}

interface FakeRequestHandle<T> {
  result: T | undefined;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded: (() => void) | null;
}

interface FakeIdb {
  factory: IDBFactory;
  /** Mutable failure switches, so a test can break the store after it worked. */
  options: FakeIdbOptions;
  /** Live rows of the attachment store, keyed by `draftKey`. */
  rows: () => Map<string, unknown>;
  /** Database names handed to `open`, in call order. */
  opened: string[];
  /** Stores the adapter created from within `onupgradeneeded`. */
  created: Array<{ name: string; keyPath: unknown }>;
}

/** Store name the fake seeds and inspects; asserted against the module's constant below. */
const FAKE_STORE = 'draft-attachments';

function fakeIdb(options: FakeIdbOptions = {}): FakeIdb {
  const stores = new Map<string, Map<string, unknown>>();
  const opened: string[] = [];
  const created: Array<{ name: string; keyPath: unknown }> = [];

  const rowsOf = (name: string): Map<string, unknown> => {
    const existing = stores.get(name);
    if (existing !== undefined) return existing;
    const rows = new Map<string, unknown>();
    stores.set(name, rows);
    return rows;
  };

  const settle = <T>(run: () => T): IDBRequest<T> => {
    const handle: FakeRequestHandle<T> = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };
    queueMicrotask(() => {
      try {
        handle.result = run();
        handle.onsuccess?.();
      } catch (error) {
        handle.error = error;
        handle.onerror?.();
      }
    });
    return handle as unknown as IDBRequest<T>;
  };

  const objectStore = (name: string): IDBObjectStore => {
    const rows = rowsOf(name);
    const store = {
      put: (value: unknown) => settle(() => {
        if (options.failPut !== undefined) throw options.failPut;
        const record = value as { draftKey?: unknown };
        if (typeof record?.draftKey !== 'string') throw new Error('keyPath value missing');
        rows.set(record.draftKey, value);
        return record.draftKey;
      }),
      get: (key: unknown) => settle(() => {
        if (options.failGet !== undefined) throw options.failGet;
        return rows.get(String(key));
      }),
      delete: (key: unknown) => settle(() => {
        if (options.failDelete !== undefined) throw options.failDelete;
        rows.delete(String(key));
        return undefined;
      }),
      getAll: () => settle(() => {
        if (options.failGetAll !== undefined) throw options.failGetAll;
        return [...rows.values()];
      }),
    };
    return store as unknown as IDBObjectStore;
  };

  const open = (name?: string): IDBOpenDBRequest => {
    if (name !== undefined) opened.push(name);
    const handle: FakeRequestHandle<IDBDatabase> = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };
    const db = {
      objectStoreNames: {
        contains: (target: string) => stores.has(target),
        get length() { return stores.size; },
        item: (index: number) => [...stores.keys()][index] ?? null,
      },
      createObjectStore: (target: string, init?: { keyPath?: unknown }) => {
        created.push({ name: target, keyPath: init?.keyPath ?? null });
        rowsOf(target);
        return { name: target, keyPath: init?.keyPath ?? null };
      },
      transaction: (target: string) => ({ objectStore: () => objectStore(target) }),
      close: () => {},
      onversionchange: null,
    } as unknown as IDBDatabase;
    queueMicrotask(() => {
      if (options.failOpen !== undefined) {
        handle.error = options.failOpen;
        handle.onerror?.();
        return;
      }
      handle.result = db;
      if (stores.size === 0) handle.onupgradeneeded?.();
      handle.onsuccess?.();
    });
    return handle as unknown as IDBOpenDBRequest;
  };

  return {
    factory: { open } as unknown as IDBFactory,
    options,
    rows: () => stores.get(FAKE_STORE) ?? new Map<string, unknown>(),
    opened,
    created,
  };
}

function requireStore(store: DraftAttachmentStore | null): DraftAttachmentStore {
  if (store === null) throw new Error('expected an IndexedDB-backed draft store');
  return store;
}

/** Base64 whose payload is exactly `bytes` bytes; requires a multiple of 3 (no padding). */
function payload(bytes: number): string {
  if (bytes % 3 !== 0) throw new Error('payload size must be a multiple of 3');
  return 'A'.repeat((bytes / 3) * 4);
}

/** An attachment whose declared size already matches its payload. */
function draftAttachment(id: string, data: string): DraftAttachment {
  const size = draftAttachmentBytes(data);
  if (size === null) throw new Error('test payloads must be base64');
  return { id, kind: 'file', name: `${id}.bin`, mimeType: 'application/octet-stream', data, size };
}

const SMALL = 'QUJD';
const NEAR_LIMIT = payload(8 * MiB - 2);
const OVER_LIMIT = payload(8 * MiB + 1);
const SEVEN_MIB = payload(7 * MiB - 1);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('draftAttachmentBytes', () => {
  it('counts the bytes a payload decodes to', () => {
    expect(draftAttachmentBytes('')).toBe(0);
    expect(draftAttachmentBytes('AA==')).toBe(1);
    expect(draftAttachmentBytes('AAA=')).toBe(2);
    expect(draftAttachmentBytes('AAAA')).toBe(3);
    expect(draftAttachmentBytes('QUJD')).toBe(3);
    expect(draftAttachmentBytes(NEAR_LIMIT)).toBe(8 * MiB - 2);
  });

  it('rejects anything that is not canonical base64', () => {
    expect(draftAttachmentBytes('AAA')).toBeNull();
    expect(draftAttachmentBytes('QU J')).toBeNull();
    expect(draftAttachmentBytes('QU-J')).toBeNull();
    expect(draftAttachmentBytes('A===')).toBeNull();
    expect(draftAttachmentBytes('=AAA')).toBeNull();
    expect(draftAttachmentBytes('QUJD====')).toBeNull();
  });
});

describe('draftAttachmentKey', () => {
  it('reuses the composer draft key instead of inventing an encoding', () => {
    const persisted = { workspaceId: 'ws', sessionId: 'sess', draft: false };
    expect(draftAttachmentKey(persisted)).toBe(composerDraftKey(persisted));
    expect(draftAttachmentKey(persisted)).toBe(sessionKey('ws', 'sess'));

    const unstarted = { workspaceId: 'ws', sessionId: 'draft-1', draft: true };
    expect(draftAttachmentKey(unstarted)).toBe(composerDraftKey(unstarted));
    expect(draftAttachmentKey(unstarted)).toBe('new:ws');

    expect(draftAttachmentKey({ workspaceId: null, sessionId: null, draft: false })).toBeNull();
  });
});

describe('sanitizeDraftAttachments', () => {
  it('keeps valid items and rebuilds them without transient fields', () => {
    const items = [{ ...draftAttachment('a', SMALL), preview: 'data:application/octet-stream;base64,QUJD' }];
    expect(sanitizeDraftAttachments(items, 'new:ws')).toEqual([draftAttachment('a', SMALL)]);
  });

  it('drops an item whose payload is not base64', () => {
    const items = [
      draftAttachment('good', SMALL),
      { id: 'bad', kind: 'file', name: 'bad.bin', mimeType: 'text/plain', data: 'not base64!', size: 11 },
    ];
    expect(sanitizeDraftAttachments(items, 'new:ws').map((item) => item.id)).toEqual(['good']);
  });

  it('drops an item whose size disagrees with its payload', () => {
    const items = [
      { ...draftAttachment('larger', SMALL), size: 4 },
      { ...draftAttachment('smaller', SMALL), size: 2 },
      draftAttachment('exact', SMALL),
    ];
    expect(sanitizeDraftAttachments(items, 'new:ws').map((item) => item.id)).toEqual(['exact']);
  });

  it('drops the attachment past the count limit', () => {
    const items = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_unused, index) => draftAttachment(`f${index}`, SMALL));
    const kept = sanitizeDraftAttachments(items, 'new:ws');
    expect(kept).toHaveLength(MAX_ATTACHMENTS);
    expect(kept.map((item) => item.id)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']);
  });

  it('keeps an item just under the per-file limit', () => {
    const kept = sanitizeDraftAttachments([draftAttachment('big', NEAR_LIMIT)], 'new:ws');
    expect(kept).toHaveLength(1);
    expect(kept[0]?.size).toBe(8 * MiB - 2);
  });

  it('drops an item over the per-file limit but keeps the earlier ones', () => {
    const items = [draftAttachment('small', SMALL), draftAttachment('huge', OVER_LIMIT)];
    expect(sanitizeDraftAttachments(items, 'new:ws').map((item) => item.id)).toEqual(['small']);
  });

  it('drops an item that would exceed the total budget', () => {
    const items = [draftAttachment('a', SEVEN_MIB), draftAttachment('b', SEVEN_MIB), draftAttachment('c', SEVEN_MIB)];
    expect(sanitizeDraftAttachments(items, 'new:ws').map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('drops legacy text attachments, primitives and items without an id', () => {
    const items = [
      { kind: 'text', name: 'note.txt', mediaType: 'text/plain', text: 'hello' },
      'nope',
      null,
      { id: '', kind: 'file', name: 'x', mimeType: 'text/plain', data: SMALL, size: 3 },
      { kind: 'file', name: 'x', mimeType: 'text/plain', data: SMALL, size: 3 },
      draftAttachment('kept', SMALL),
    ];
    expect(sanitizeDraftAttachments(items, 'new:ws').map((item) => item.id)).toEqual(['kept']);
  });

  it('reads a stored record and rejects one that names another draft', () => {
    const record = { draftKey: 'new:ws', attachments: [draftAttachment('a', SMALL)], updatedAt: 5 };
    expect(sanitizeDraftAttachments(record, 'new:ws').map((item) => item.id)).toEqual(['a']);
    expect(sanitizeDraftAttachments(record, 'new:other')).toEqual([]);
  });

  it('returns nothing for values that are not attachment lists', () => {
    expect(sanitizeDraftAttachments(null, 'new:ws')).toEqual([]);
    expect(sanitizeDraftAttachments('[]', 'new:ws')).toEqual([]);
    expect(sanitizeDraftAttachments({ attachments: 'x' }, 'new:ws')).toEqual([]);
    expect(sanitizeDraftAttachments([draftAttachment('a', SMALL)], '')).toEqual([]);
  });
});

describe('draftAttachmentRecord', () => {
  it('stamps the draft key and a timestamp', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    expect(draftAttachmentRecord('new:ws', [draftAttachment('a', SMALL)])).toEqual({
      draftKey: 'new:ws',
      attachments: [draftAttachment('a', SMALL)],
      updatedAt: 1234,
    });
  });

  it('refuses to build a row without a key or surviving attachments', () => {
    expect(draftAttachmentRecord('', [draftAttachment('a', SMALL)])).toBeNull();
    expect(draftAttachmentRecord('new:ws', [])).toBeNull();
    expect(draftAttachmentRecord('new:ws', [{ ...draftAttachment('a', SMALL), size: 9 }])).toBeNull();
  });
});

describe('createIndexedDbDraftStore', () => {
  it('is null when the platform has no factory', () => {
    expect(createIndexedDbDraftStore(undefined)).toBeNull();
  });

  it('is null when the factory throws while opening', () => {
    const factory = {
      open: () => {
        throw new Error('blocked');
      },
    } as unknown as IDBFactory;
    expect(createIndexedDbDraftStore(factory)).toBeNull();
  });

  it('opens the contracted database and store exactly once', async () => {
    const idb = fakeIdb();
    const store = requireStore(createIndexedDbDraftStore(idb.factory));
    await store.write('new:ws', [draftAttachment('a', SMALL)]);
    await store.read('new:ws');
    await store.remove('new:ws');

    expect(DRAFT_ATTACHMENT_DB_NAME).toBe('omniagent.drafts');
    expect(DRAFT_ATTACHMENT_STORE_NAME).toBe(FAKE_STORE);
    expect(idb.opened).toEqual(['omniagent.drafts']);
    expect(idb.created).toEqual([{ name: 'draft-attachments', keyPath: 'draftKey' }]);
  });

  it('round-trips a draft without its transient preview', async () => {
    const idb = fakeIdb();
    const store = requireStore(createIndexedDbDraftStore(idb.factory));
    const image = {
      id: 'img',
      kind: 'image' as const,
      name: 'cat.png',
      mimeType: 'image/png',
      data: SMALL,
      size: 3,
      preview: 'data:image/png;base64,QUJD',
    };
    expect(await store.write('new:ws', [draftAttachment('a', SMALL), image])).toBe(true);
    expect(idb.rows().get('new:ws')).toMatchObject({ draftKey: 'new:ws' });
    expect(await store.read('new:ws')).toEqual([
      draftAttachment('a', SMALL),
      { id: 'img', kind: 'image', name: 'cat.png', mimeType: 'image/png', data: SMALL, size: 3 },
    ]);
  });

  it('returns nothing for a draft that was never stored', async () => {
    const store = requireStore(createIndexedDbDraftStore(fakeIdb().factory));
    expect(await store.read('new:missing')).toEqual([]);
  });

  it('ignores empty draft keys', async () => {
    const idb = fakeIdb();
    const store = requireStore(createIndexedDbDraftStore(idb.factory));
    expect(await store.read('')).toEqual([]);
    expect(await store.write('', [draftAttachment('a', SMALL)])).toBe(false);
    expect(await store.remove('')).toBe(false);
    expect(idb.rows().size).toBe(0);
  });

  it('returns nothing when reading throws', async () => {
    const store = requireStore(createIndexedDbDraftStore(fakeIdb({ failGet: new Error('boom') }).factory));
    await expect(store.read('new:ws')).resolves.toEqual([]);
  });

  it('degrades to no persistence when the database cannot open, without retrying', async () => {
    const idb = fakeIdb({ failOpen: new Error('denied') });
    const store = requireStore(createIndexedDbDraftStore(idb.factory));
    await expect(store.read('new:ws')).resolves.toEqual([]);
    await expect(store.write('new:ws', [draftAttachment('a', SMALL)])).resolves.toBe(false);
    await expect(store.remove('new:ws')).resolves.toBe(false);
    await expect(store.prune()).resolves.toBe(false);
    // One attempt per store, not one per call: an exhausted browser must not be stormed.
    expect(idb.opened).toHaveLength(1);
  });

  it('reports a failed delete without throwing', async () => {
    const idb = fakeIdb();
    const store = requireStore(createIndexedDbDraftStore(idb.factory));
    expect(await store.write('new:ws', [draftAttachment('a', SMALL)])).toBe(true);
    idb.options.failDelete = new Error('transient');
    await expect(store.remove('new:ws')).resolves.toBe(false);
  });

  it('reports a quota failure as a failed write and keeps the previous row', async () => {
    const idb = fakeIdb();
    const store = requireStore(createIndexedDbDraftStore(idb.factory));
    expect(await store.write('new:ws', [draftAttachment('a', SMALL)])).toBe(true);
    idb.options.failPut = new DOMException('quota', 'QuotaExceededError');
    expect(await store.write('new:ws', [draftAttachment('b', SMALL)])).toBe(false);
    expect(await store.read('new:ws')).toEqual([draftAttachment('a', SMALL)]);
  });

  it('drops the row when nothing survives validation', async () => {
    const idb = fakeIdb();
    const store = requireStore(createIndexedDbDraftStore(idb.factory));
    expect(await store.write('new:ws', [draftAttachment('a', SMALL)])).toBe(true);
    expect(await store.write('new:ws', [{ ...draftAttachment('bad', SMALL), size: 99 }])).toBe(true);
    expect(await store.read('new:ws')).toEqual([]);
    expect(idb.rows().has('new:ws')).toBe(false);
  });

  it('removes a draft', async () => {
    const store = requireStore(createIndexedDbDraftStore(fakeIdb().factory));
    expect(await store.write('new:ws', [draftAttachment('a', SMALL)])).toBe(true);
    expect(await store.remove('new:ws')).toBe(true);
    expect(await store.read('new:ws')).toEqual([]);
  });

  it('keeps only the newest eight drafts', async () => {
    const idb = fakeIdb();
    const store = requireStore(createIndexedDbDraftStore(idb.factory));
    const now = vi.spyOn(Date, 'now');
    for (let index = 0; index < 10; index += 1) {
      now.mockReturnValue(1_000 + index * 1_000);
      expect(await store.write(`new:ws${index}`, [draftAttachment(`f${index}`, SMALL)])).toBe(true);
    }
    now.mockRestore();

    expect(MAX_DRAFT_ATTACHMENT_RECORDS).toBe(8);
    expect([...idb.rows().keys()].sort()).toEqual([
      'new:ws2', 'new:ws3', 'new:ws4', 'new:ws5', 'new:ws6', 'new:ws7', 'new:ws8', 'new:ws9',
    ]);
    expect(await store.read('new:ws9')).toHaveLength(1);
    expect(await store.read('new:ws1')).toEqual([]);
    expect(await store.read('new:ws0')).toEqual([]);
  });

  it('prunes on demand and reports failures instead of throwing', async () => {
    const idb = fakeIdb();
    const store = requireStore(createIndexedDbDraftStore(idb.factory));
    await expect(store.prune()).resolves.toBe(true);
    idb.options.failGetAll = new Error('boom');
    await expect(store.prune()).resolves.toBe(false);
  });

  it('still stores the row when retention housekeeping fails', async () => {
    const idb = fakeIdb({ failGetAll: new Error('boom') });
    const store = requireStore(createIndexedDbDraftStore(idb.factory));
    expect(await store.write('new:ws', [draftAttachment('a', SMALL)])).toBe(true);
    expect(await store.read('new:ws')).toHaveLength(1);
  });

  it('trims a stored row that breaks the limits', async () => {
    const idb = fakeIdb();
    const store = requireStore(createIndexedDbDraftStore(idb.factory));
    // Prime the database so the store exists, then plant rows the adapter never wrote.
    await store.read('new:ws');
    idb.rows().set('new:ws', {
      draftKey: 'new:ws',
      attachments: Array.from({ length: 10 }, (_unused, index) => draftAttachment(`f${index}`, SMALL)),
      updatedAt: 1,
    });
    idb.rows().set('new:corrupt', { draftKey: 'new:corrupt', attachments: 'nope', updatedAt: 2 });

    expect(await store.read('new:ws')).toHaveLength(MAX_ATTACHMENTS);
    expect(await store.read('new:corrupt')).toEqual([]);
  });
});

describe('resolveDraftAttachmentStore', () => {
  it('is null when the platform exposes no IndexedDB', () => {
    vi.stubGlobal('indexedDB', undefined);
    expect(resolveDraftAttachmentStore()).toBeNull();
  });

  it('uses the global factory when one exists', async () => {
    const idb = fakeIdb();
    vi.stubGlobal('indexedDB', idb.factory);
    const store = requireStore(resolveDraftAttachmentStore());
    expect(await store.write('new:ws', [draftAttachment('a', SMALL)])).toBe(true);
    expect(await store.read('new:ws')).toEqual([draftAttachment('a', SMALL)]);
  });
});
