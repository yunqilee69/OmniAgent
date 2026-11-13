/** localStorage key for the dragged transcript width preference (px). */
export const WIDTH_PREF_KEY = 'omniagent.conversation.contentWidth';
/** Floor for a dragged content width. */
export const CONTENT_MIN = 640;
/** Horizontal room reserved for both handles and their safe edge zones. */
export const CONTENT_EDGE_BUDGET = 176;

/** Read a valid persisted width preference, or null when absent or corrupt. */
export function readWidthPreference(storage: Pick<Storage, 'getItem'> | null): number | null {
  const raw = storage?.getItem(WIDTH_PREF_KEY) ?? null;
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Resolve the width displayed for one measured conversation column.
 * Without a preference the column takes 64% of itself, clamped to 680–920px.
 * A preference is clamped between the floor and the room the handles leave.
 */
export function resolveContentWidth(columnWidth: number, preference: number | null): number {
  const max = Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET);
  if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), max);
  return Math.max(680, Math.min(columnWidth * 0.64, 920));
}
