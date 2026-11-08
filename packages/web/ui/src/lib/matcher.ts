/**
 * Case-insensitive LIKE-style matching for composer menu sources.
 *
 * A query is split on whitespace; every term must match somewhere in the
 * candidate fields. Better positions rank first (exact, prefix, word prefix,
 * substring) and an ordered subsequence is the last-resort fallback.
 */
const WORD_BREAK = /[^a-z0-9]+/u;

/** Per-term score; -1 means the term does not match. */
export function matchScore(value: string, query: string): number {
  const needle = query.trim().toLowerCase();
  if (needle === '') return 0;
  const haystack = value.toLowerCase();
  if (haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 1;
  if (haystack.split(WORD_BREAK).some((part) => part.startsWith(needle))) return 2;
  if (haystack.includes(needle)) return 3;
  let cursor = 0;
  for (const character of haystack) {
    if (character === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return 4;
  }
  return -1;
}

/** Score a candidate across several searchable fields; -1 means no match. */
export function likeScore(values: readonly (string | null | undefined)[], rawQuery: string): number {
  const terms = rawQuery.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return 0;
  let score = 0;
  for (const term of terms) {
    let best = -1;
    for (const [index, value] of values.entries()) {
      if (value === null || value === undefined || value === '') continue;
      const candidate = matchScore(value, term);
      if (candidate < 0) continue;
      // Earlier fields are more authoritative: a name prefix beats the same
      // match found later in a description.
      const weighted = candidate * 10 + index;
      if (best < 0 || weighted < best) best = weighted;
    }
    if (best < 0) return -1;
    score += best;
  }
  return score;
}

/** Filter and rank items while preserving the source order for equal scores. */
export function rankLike<T>(
  items: readonly T[],
  rawQuery: string,
  fields: (item: T) => readonly (string | null | undefined)[],
): T[] {
  const ranked: Array<{ item: T; score: number; index: number }> = [];
  for (const [index, item] of items.entries()) {
    const score = likeScore(fields(item), rawQuery);
    if (score >= 0) ranked.push({ item, score, index });
  }
  ranked.sort((left, right) => left.score - right.score || left.index - right.index);
  return ranked.map(({ item }) => item);
}
