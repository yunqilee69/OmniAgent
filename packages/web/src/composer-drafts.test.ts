import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearComposerDraft,
  composerDraftKey,
  draftFollowsSession,
  readComposerDraft,
  writeComposerDraft,
} from '../ui/src/lib/composer-drafts';
import { sessionKey } from '../ui/src/lib/store.ts';

const PREFIX = 'omniagent.composerDraft:';

let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  vi.stubGlobal('localStorage', {
    get length(): number { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('composer draft keys', () => {
  it('keys a persisted session by workspace and session', () => {
    expect(composerDraftKey({ workspaceId: 'a', sessionId: 's1', draft: false })).toBe(sessionKey('a', 's1'));
    expect(composerDraftKey({ workspaceId: 'a', sessionId: 's1', draft: false }))
      .not.toBe(composerDraftKey({ workspaceId: 'b', sessionId: 's1', draft: false }));
  });

  it('keys a session the host has not created yet by its workspace', () => {
    const unstarted = composerDraftKey({ workspaceId: 'a', sessionId: null, draft: false });
    // A UI-only draft id changes on every page load, so it must not name the draft.
    expect(composerDraftKey({ workspaceId: 'a', sessionId: 'draft-1', draft: true })).toBe(unstarted);
    expect(composerDraftKey({ workspaceId: 'a', sessionId: 'draft-2', draft: true })).toBe(unstarted);
    expect(composerDraftKey({ workspaceId: 'b', sessionId: 'draft-1', draft: true })).not.toBe(unstarted);
  });

  it('has no key before a workspace is selected', () => {
    expect(composerDraftKey({ workspaceId: null, sessionId: null, draft: false })).toBeNull();
  });

  it('follows only the same unstarted session across a workspace move', () => {
    const draftInA = { workspaceId: 'a', sessionId: 'draft-1', draft: true };
    expect(draftFollowsSession(draftInA, { workspaceId: 'b', sessionId: 'draft-1', draft: true })).toBe(true);
    expect(draftFollowsSession(draftInA, { workspaceId: 'b', sessionId: null, draft: false })).toBe(false);
    expect(draftFollowsSession(draftInA, { workspaceId: 'a', sessionId: 's1', draft: false })).toBe(false);
    expect(draftFollowsSession(
      { workspaceId: 'a', sessionId: 's1', draft: false },
      { workspaceId: 'b', sessionId: 's1', draft: false },
    )).toBe(false);
  });
});

describe('composer draft storage', () => {
  const key = composerDraftKey({ workspaceId: 'a', sessionId: null, draft: false })!;

  it('round-trips the text typed for a target', () => {
    writeComposerDraft(key, 'fix the flaky test');
    expect(readComposerDraft(key)).toBe('fix the flaky test');
    writeComposerDraft(key, 'and then the rest');
    expect(readComposerDraft(key)).toBe('and then the rest');
  });

  it('treats an empty draft as nothing to restore', () => {
    writeComposerDraft(key, 'text');
    writeComposerDraft(key, '');
    expect(readComposerDraft(key)).toBe('');
    expect(values.has(PREFIX + key)).toBe(false);
  });

  it('forgets a sent draft', () => {
    writeComposerDraft(key, 'text');
    clearComposerDraft(key);
    expect(readComposerDraft(key)).toBe('');
  });

  it('ignores a corrupt entry', () => {
    values.set(PREFIX + key, '{not json');
    expect(readComposerDraft(key)).toBe('');
    values.set(PREFIX + key, JSON.stringify({ at: 1 }));
    expect(readComposerDraft(key)).toBe('');
  });

  it('keeps typing when storage rejects the write', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => {},
    });
    expect(() => { writeComposerDraft(key, 'text'); }).not.toThrow();
    expect(readComposerDraft(key)).toBe('');
  });

  it('drops the oldest drafts once the cache is full', () => {
    vi.useFakeTimers();
    for (let index = 0; index < 40; index += 1) {
      vi.setSystemTime(new Date(2024, 0, 1, 0, 0, index));
      writeComposerDraft(`k${index}`, `text ${index}`);
    }
    vi.useRealTimers();
    expect(readComposerDraft('k39')).toBe('text 39');
    expect(values.size).toBe(32);
    expect(readComposerDraft('k0')).toBe('');
  });
});
