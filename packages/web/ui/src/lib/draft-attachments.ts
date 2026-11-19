/**
 * IndexedDB persistence for composer draft attachments (plan §6.5-D1, §7.3).
 *
 * The draft *text* stays in `localStorage`; only the attachments — base64 strings
 * far too large for a 5–10MB localStorage quota — live here, under the very same
 * {@link composerDraftKey} so both halves are written, cleared and migrated together.
 *
 * Two layers:
 * - pure validation ({@link draftAttachmentBytes}, {@link sanitizeDraftAttachments},
 *   {@link draftAttachmentRecord}) that re-checks every stored item before it reaches
 *   the composer: shape, recomputed byte count, and the 8 / 8MiB / 20MiB limits;
 * - a thin adapter ({@link createIndexedDbDraftStore}) with no dependencies beyond the
 *   platform's IndexedDB, which never throws: every failure (missing factory, open
 *   failure, quota exceeded, corrupt row) degrades to "no persistence".
 */
import { composerDraftKey, type DraftTarget } from './composer-drafts.ts';
import { attachmentLimitError, restoreSendAttachment } from './wire.ts';

/** Database holding draft attachment records. Part of the §7.3 contract. */
export const DRAFT_ATTACHMENT_DB_NAME = 'omniagent.drafts';
/** Object store inside {@link DRAFT_ATTACHMENT_DB_NAME}; keyed by `draftKey`. */
export const DRAFT_ATTACHMENT_STORE_NAME = 'draft-attachments';
/** Newest records kept; older drafts are dropped on every write (plan §7.3). */
export const MAX_DRAFT_ATTACHMENT_RECORDS = 8;
/** Bumped whenever the record shape changes; v1 is the only schema so far. */
const DRAFT_ATTACHMENT_DB_VERSION = 1;
/** Property name of the store key, i.e. one record per draft key. */
const DRAFT_ATTACHMENT_KEY_PATH = 'draftKey';

/** One attachment cached for a draft: the composer's state minus ephemeral previews. */
export interface DraftAttachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  mimeType: string;
  /** Base64 payload, exactly what `SendAttachment` carries on the wire. */
  data: string;
  /** Byte count decoded from {@link data}; re-derived on the way in and out. */
  size: number;
}

/** One row of the store: every attachment of a single draft. */
export interface DraftAttachmentRecord {
  draftKey: string;
  attachments: DraftAttachment[];
  updatedAt: number;
}

/** Persistence seam for draft attachments; the IndexedDB adapter implements it. */
export interface DraftAttachmentStore {
  /** Attachments cached for a draft key, already sanitized; `[]` when absent or unavailable. */
  read(key: string): Promise<DraftAttachment[]>;
  /** Replace the whole record; an empty list drops it. `false` when nothing was stored. */
  write(key: string, attachments: readonly DraftAttachment[]): Promise<boolean>;
  /** Forget one draft's attachments. `false` when the removal did not stick. */
  remove(key: string): Promise<boolean>;
  /** Keep only the newest {@link MAX_DRAFT_ATTACHMENT_RECORDS} records. */
  prune(): Promise<boolean>;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Bytes held by a base64 payload, or null when the string is not base64.
 *
 * The composer writes base64 produced by `FileReader`/`btoa`, i.e. no whitespace and
 * canonical padding, so anything else is treated as a corrupt record: the size the
 * composer displayed and the payload it would upload can then never disagree.
 */
export function draftAttachmentBytes(data: string): number | null {
  if (data.length % 4 !== 0) return null;
  if (!BASE64.test(data)) return null;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/** The store key of a draft target: the draft text's key, never a new encoding. */
export function draftAttachmentKey(target: DraftTarget): string | null {
  return composerDraftKey(target);
}

/** Narrow an unknown to a plain object, matching how the wire validators work. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Attachments that are safe to hand to the composer.
 *
 * Accepts either a stored record (`{ draftKey, attachments }`) or a bare array, and
 * drops — item by item, never throwing — anything whose shape fails
 * `restoreSendAttachment`, whose `size` disagrees with its payload, or that would break
 * the shared 8 files / 8MiB each / 20MiB total limits. A record naming another draft
 * key is stale and yields nothing.
 */
export function sanitizeDraftAttachments(value: unknown, key: string): DraftAttachment[] {
  if (key === '') return [];
  const record = asRecord(value);
  const items: unknown = Array.isArray(value) ? value : record?.attachments;
  if (!Array.isArray(items)) return [];
  if (record !== null && typeof record.draftKey === 'string' && record.draftKey !== key) return [];
  const kept: DraftAttachment[] = [];
  let total = 0;
  for (const item of items as unknown[]) {
    const restored = restoreSendAttachment(item);
    if (restored === null) continue;
    // Drafts only ever hold files and images; legacy queued text has no base64 payload.
    if (restored.kind === 'text') continue;
    const raw = asRecord(item);
    const id = raw?.id;
    const size = raw?.size;
    if (typeof id !== 'string' || id === '') continue;
    if (typeof size !== 'number') continue;
    const bytes = draftAttachmentBytes(restored.data);
    if (bytes === null || bytes !== size) continue;
    if (attachmentLimitError(bytes, total, kept.length) !== null) continue;
    kept.push({
      id,
      kind: restored.kind,
      name: restored.name,
      mimeType: restored.mimeType,
      data: restored.data,
      size: bytes,
    });
    total += bytes;
  }
  return kept;
}

/**
 * The row to store for a draft, or null when there is nothing worth keeping.
 *
 * Runs the same validation as {@link sanitizeDraftAttachments}, so a write can never
 * persist what a later read would reject.
 */
export function draftAttachmentRecord(key: string, attachments: unknown): DraftAttachmentRecord | null {
  if (key === '') return null;
  const sanitized = sanitizeDraftAttachments(attachments, key);
  if (sanitized.length === 0) return null;
  return { draftKey: key, attachments: sanitized, updatedAt: Date.now() };
}

/**
 * Resolve an IndexedDB request into a promise settled by its success or error event.
 *
 * Settling on the request rather than on `transaction.oncomplete` is enough here: the
 * only failure the caller reacts to (a write past the quota) fires on the put request
 * itself, and each call's request is ordered after every earlier request on the store.
 */
function runRequest<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  act: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let request: IDBRequest<T>;
    try {
      request = act(db.transaction(DRAFT_ATTACHMENT_STORE_NAME, mode).objectStore(DRAFT_ATTACHMENT_STORE_NAME));
    } catch (error) {
      reject(error);
      return;
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

/**
 * Attach the schema handlers to an open request.
 *
 * Resolves null instead of rejecting: a database another tab blocks is treated like an
 * unavailable store, so callers degrade to in-memory attachments instead of hanging.
 */
function settleOpen(request: IDBOpenDBRequest): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (db: IDBDatabase | null): void => {
      if (settled) return;
      settled = true;
      resolve(db);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFT_ATTACHMENT_STORE_NAME)) {
        db.createObjectStore(DRAFT_ATTACHMENT_STORE_NAME, { keyPath: DRAFT_ATTACHMENT_KEY_PATH });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Let another tab upgrade the schema rather than holding its open request hostage.
      db.onversionchange = () => db.close();
      settle(db);
    };
    request.onerror = () => settle(null);
    request.onblocked = () => settle(null);
  });
}

/** Sort rows newest first and delete everything past the retention limit. */
async function pruneRecords(db: IDBDatabase): Promise<void> {
  const rows: readonly unknown[] = await runRequest<unknown[]>(db, 'readonly', (store) => store.getAll());
  const timed: Array<{ draftKey: string; updatedAt: number }> = [];
  for (const row of rows) {
    const raw = asRecord(row);
    const draftKey = raw?.draftKey;
    const updatedAt = raw?.updatedAt;
    if (typeof draftKey !== 'string') continue;
    timed.push({ draftKey, updatedAt: typeof updatedAt === 'number' ? updatedAt : 0 });
  }
  timed.sort((left, right) => right.updatedAt - left.updatedAt);
  for (const stale of timed.slice(MAX_DRAFT_ATTACHMENT_RECORDS)) {
    await runRequest(db, 'readwrite', (store) => store.delete(stale.draftKey));
  }
}

/**
 * Attachments store backed by IndexedDB, or null when the platform has none.
 *
 * One connection is opened lazily and reused; a failed open is not retried for the life
 * of the store, so a blocked or quota-exhausted browser does not storm the API.
 */
export function createIndexedDbDraftStore(
  factory: IDBFactory | undefined,
  dbName: string = DRAFT_ATTACHMENT_DB_NAME,
): DraftAttachmentStore | null {
  if (factory === undefined || factory === null) return null;
  let opening: Promise<IDBDatabase | null>;
  try {
    opening = settleOpen(factory.open(dbName, DRAFT_ATTACHMENT_DB_VERSION));
  } catch {
    // Some privacy modes throw synchronously here rather than firing an error event.
    return null;
  }
  const database = (): Promise<IDBDatabase | null> => opening;
  const prune = async (): Promise<boolean> => {
    try {
      const db = await database();
      if (db === null) return false;
      await pruneRecords(db);
      return true;
    } catch {
      return false;
    }
  };
  return {
    async read(key: string): Promise<DraftAttachment[]> {
      try {
        const db = await database();
        if (db === null || key === '') return [];
        const record = await runRequest<unknown>(db, 'readonly', (store) => store.get(key));
        return sanitizeDraftAttachments(record, key);
      } catch {
        return [];
      }
    },
    async write(key: string, attachments: readonly DraftAttachment[]): Promise<boolean> {
      try {
        const db = await database();
        if (db === null || key === '') return false;
        const record = draftAttachmentRecord(key, attachments);
        if (record === null) {
          // Nothing left to restore: drop the row instead of storing an empty one.
          await runRequest(db, 'readwrite', (store) => store.delete(key));
          return true;
        }
        await runRequest(db, 'readwrite', (store) => store.put(record));
        // Retention is housekeeping: the record itself is already durable.
        await prune();
        return true;
      } catch {
        return false;
      }
    },
    async remove(key: string): Promise<boolean> {
      try {
        const db = await database();
        if (db === null || key === '') return false;
        await runRequest(db, 'readwrite', (store) => store.delete(key));
        return true;
      } catch {
        return false;
      }
    },
    prune,
  };
}

/** The browser's attachment store, or null when IndexedDB is missing or unusable. */
export function resolveDraftAttachmentStore(): DraftAttachmentStore | null {
  let factory: IDBFactory | undefined;
  try {
    factory = globalThis.indexedDB;
  } catch {
    // Reaching into storage throws when the browser has it disabled.
    return null;
  }
  return createIndexedDbDraftStore(factory);
}
