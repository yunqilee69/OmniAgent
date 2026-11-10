import { describe, expect, it } from 'vitest';
import {
  detectTrigger,
  directoryReference,
  enterGesture,
  fileReference,
  replaceRange,
  skillReference,
} from '../ui/src/lib/composer-trigger';

describe('composer trigger detection', () => {
  it('distinguishes plain and complementary Enter without stealing modified shortcuts', () => {
    const base = { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, getModifierState: () => false };
    expect(enterGesture(base)).toBe('plain');
    expect(enterGesture({ ...base, ctrlKey: true })).toBe('complementary');
    expect(enterGesture({ ...base, metaKey: true })).toBe('complementary');
    expect(enterGesture({ ...base, shiftKey: true })).toBeNull();
    expect(enterGesture({ ...base, altKey: true })).toBeNull();
    expect(enterGesture({ ...base, ctrlKey: true, metaKey: true })).toBeNull();
    expect(enterGesture({ ...base, ctrlKey: true, shiftKey: true })).toBeNull();
    expect(enterGesture({ ...base, getModifierState: (key) => key === 'AltGraph' })).toBeNull();
  });
  it('detects @ file references at a token boundary', () => {
    expect(detectTrigger('@', 1)).toEqual({ kind: 'file', prefix: '@', query: '', start: 0, end: 1 });
    expect(detectTrigger('open @src/main.ts', 17)).toEqual({
      kind: 'file', prefix: '@', query: 'src/main.ts', start: 5, end: 17,
    });
    expect(detectTrigger('@文件', 3)).toMatchObject({ kind: 'file', query: '文件' });
  });

  it('keeps a quoted @ path in one trigger', () => {
    expect(detectTrigger('@"my folder/file.ts', 19)).toEqual({
      kind: 'file', prefix: '@', query: 'my folder/file.ts', start: 0, end: 19,
    });
    expect(detectTrigger('see @"a b.ts" ', 14)).toBeNull();
  });

  it('does not treat prose glued to @ # or $ as a trigger', () => {
    expect(detectTrigger('a@b', 3)).toBeNull();
    expect(detectTrigger('C#', 2)).toBeNull();
    expect(detectTrigger('US$', 3)).toBeNull();
    expect(detectTrigger('${name}', 7)).toBeNull();
  });

  it('detects # session references', () => {
    expect(detectTrigger('#', 1)).toEqual({ kind: 'session', prefix: '#', query: '', start: 0, end: 1 });
    expect(detectTrigger('see #alpha', 10)).toMatchObject({ kind: 'session', query: 'alpha' });
    expect(detectTrigger('##', 2)).toBeNull();
  });

  it('detects / commands but not URLs or paths', () => {
    expect(detectTrigger('/', 1)).toEqual({ kind: 'command', prefix: '/', query: '', start: 0, end: 1 });
    expect(detectTrigger('/compact', 8)).toMatchObject({ kind: 'command', query: 'compact' });
    expect(detectTrigger('/init', 5)).toMatchObject({ kind: 'command', query: 'init' });
    expect(replaceRange('/init', 0, 5, '/init ')).toEqual({ value: '/init ', caret: 6 });
    expect(detectTrigger('//', 2)).toBeNull();
    expect(detectTrigger('/api/files', 10)).toBeNull();
    expect(detectTrigger('https://example.com', 19)).toBeNull();
  });

  it('detects $ skills', () => {
    expect(detectTrigger('$', 1)).toEqual({ kind: 'skill', prefix: '$', query: '', start: 0, end: 1 });
    expect(detectTrigger('use $reviewer', 13)).toMatchObject({ kind: 'skill', query: 'reviewer' });
  });

  it('ignores a trigger outside the caret token', () => {
    expect(detectTrigger('@file and more', 14)).toBeNull();
    expect(detectTrigger('@file', 0)).toBeNull();
    expect(detectTrigger('@file', 99)).toBeNull();
  });

  it('replaces the trigger range and inserts references', () => {
    expect(replaceRange('run /plan now', 4, 9, '')).toEqual({ value: 'run  now', caret: 4 });
    expect(replaceRange('say @a', 4, 6, 'hello')).toEqual({ value: 'say hello', caret: 9 });
    expect(fileReference('src/main.ts')).toBe('@src/main.ts ');
    expect(fileReference('my folder/file.ts')).toBe('@"my folder/file.ts" ');
    // Keeping the quote open lets the menu continue into the directory.
    expect(directoryReference('my folder')).toBe('@"my folder/');
    expect(skillReference('reviewer')).toBe('$reviewer ');
  });
});
