import { describe, expect, it } from 'vitest';
import { likeScore, matchScore, rankLike } from '../ui/src/lib/matcher';

describe('composer LIKE matching', () => {
  it('ranks exact, prefix, word-prefix, substring and subsequence hits in that order', () => {
    expect(matchScore('compact', 'compact')).toBe(0);
    expect(matchScore('compact context', 'compact')).toBe(1);
    expect(matchScore('run compact context', 'compact')).toBe(2);
    expect(matchScore('precompact', 'compact')).toBe(3);
    expect(matchScore('create goal context', 'cgc')).toBe(4);
    expect(matchScore('context', 'zzz')).toBe(-1);
  });

  it('matches terms against any field and is case-insensitive', () => {
    expect(likeScore(['Reviewer', 'Reviews code changes'], 'review')).toBeGreaterThanOrEqual(0);
    expect(likeScore(['Reviewer', 'Reviews code changes'], 'CODE reviewer')).toBeGreaterThanOrEqual(0);
    expect(likeScore(['Reviewer', 'Reviews code changes'], 'missing term')).toBe(-1);
    expect(likeScore(['Anything'], '')).toBe(0);
  });

  it('prefers a match in an earlier field when scores tie', () => {
    const name = likeScore(['reviewer', 'Reviews code changes'], 'rev');
    const description = likeScore(['code-review', 'Review the changes'], 'rev');
    expect(name).toBeLessThan(description);
  });

  it('sorts better matches first while preserving source order for ties', () => {
    const items = ['reset workspace', 'workspace', 'workspace reset', 'other'];
    expect(rankLike(items, 'workspace', (item) => [item])).toEqual([
      'workspace',
      'workspace reset',
      'reset workspace',
    ]);
    expect(rankLike(['beta', 'alpha'], '', (item) => [item])).toEqual(['beta', 'alpha']);
  });

  it('matches Chinese text with the same prefix and substring rules', () => {
    expect(matchScore('压缩上下文', '压缩')).toBe(1);
    expect(matchScore('压缩上下文', '上下')).toBe(3);
    expect(rankLike(['近期会话', '压缩上下文'], '压缩', (item) => [item])).toEqual(['压缩上下文']);
  });
});
