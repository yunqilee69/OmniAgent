/** Persisted soft-wrap preference shared by the code and text viewers. */
import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'omniagent.preview.wrap';
let cached: boolean | undefined;
const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    // Blocked storage (private mode) keeps the default instead of failing the render.
    return true;
  }
}

function getSnapshot(): boolean {
  cached ??= readStored();
  return cached;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function toggle(): void {
  cached = !getSnapshot();
  try { window.localStorage.setItem(STORAGE_KEY, cached ? 'on' : 'off'); } catch { /* storage is optional */ }
  for (const listener of listeners) listener();
}

/**
 * Soft-wrap state for a source preview. Defaults to on, survives a reload, and
 * stays consistent across viewers because every instance subscribes to one value.
 * @returns the current preference and a toggle.
 */
export function useWrapPreference(): [boolean, () => void] {
  const wrap = useSyncExternalStore(subscribe, getSnapshot, () => true);
  const stableToggle = useCallback(toggle, []);
  return [wrap, stableToggle];
}
