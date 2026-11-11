import { sessionKey } from './store.ts';

/**
 * Which text the composer is editing.
 *
 * A persisted session owns its own draft. A session the host has not created yet
 * cannot: UI-only draft ids (`draft-…`) are handed out fresh on every page load,
 * so keying by one drops the text the moment the page reloads. Those drafts
 * belong to their workspace instead — one unstarted-session draft per workspace.
 */
export interface DraftTarget {
  workspaceId: string | null;
  sessionId: string | null;
  /** The session is still a UI-only draft: nothing is persisted on the host yet. */
  draft: boolean;
}

/** Name of the draft a target owns, or null while no workspace is selected. */
export function composerDraftKey(target: DraftTarget): string | null {
  if (target.workspaceId === null) return null;
  if (target.sessionId === null || target.draft) return `new:${target.workspaceId}`;
  return sessionKey(target.workspaceId, target.sessionId);
}

/**
 * Whether typed text moves with the composer between two targets.
 *
 * Only the same unstarted session does: pointing an existing draft session at
 * another workspace keeps what was typed in it, while switching to another
 * session — or to another workspace's unstarted session — leaves each target its
 * own draft.
 */
export function draftFollowsSession(previous: DraftTarget, next: DraftTarget): boolean {
  return previous.draft && next.draft && previous.sessionId !== null && previous.sessionId === next.sessionId;
}

const STORAGE_PREFIX = 'omniagent.composerDraft:';
/** Keeps a long-lived browser from hoarding a draft per session ever edited. */
const MAX_DRAFTS = 32;

interface StoredDraft {
  text: string;
  at: number;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Reaching into storage throws when the browser has it disabled.
    return null;
  }
}

/** Text cached for a draft key, or '' when nothing was typed or storage is unavailable. */
export function readComposerDraft(key: string): string {
  const store = storage();
  if (store === null) return '';
  try {
    const parsed: unknown = JSON.parse(store.getItem(STORAGE_PREFIX + key) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null) return '';
    const text = (parsed as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/** Cache drafted text; an empty text clears the entry. */
export function writeComposerDraft(key: string, text: string): void {
  if (text === '') {
    clearComposerDraft(key);
    return;
  }
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(STORAGE_PREFIX + key, JSON.stringify({ text, at: Date.now() } satisfies StoredDraft));
  } catch {
    // A full or read-only store must never block typing.
    return;
  }
  pruneComposerDrafts(store);
}

/** Forget one draft, e.g. once its text was sent. */
export function clearComposerDraft(key: string): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(STORAGE_PREFIX + key);
  } catch {
    // Persistence is best-effort.
  }
}

/** Drop the oldest drafts once the store holds more than {@link MAX_DRAFTS}. */
function pruneComposerDrafts(store: Storage): void {
  try {
    // Cheap short-circuit: the whole store cannot hold more drafts than it holds keys.
    if (store.length <= MAX_DRAFTS) return;
    const names: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const name = store.key(index);
      if (name !== null && name.startsWith(STORAGE_PREFIX)) names.push(name);
    }
    if (names.length <= MAX_DRAFTS) return;
    const oldest = names
      .map((name) => ({ name, at: storedAt(store, name) }))
      .sort((left, right) => left.at - right.at)
      .slice(0, names.length - MAX_DRAFTS);
    for (const entry of oldest) store.removeItem(entry.name);
  } catch {
    // Persistence is best-effort.
  }
}

function storedAt(store: Storage, name: string): number {
  try {
    const parsed: unknown = JSON.parse(store.getItem(name) ?? 'null');
    const at = typeof parsed === 'object' && parsed !== null ? (parsed as { at?: unknown }).at : undefined;
    return typeof at === 'number' ? at : 0;
  } catch {
    return 0;
  }
}
