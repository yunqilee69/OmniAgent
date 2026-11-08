/**
 * Composer shortcut triggers: `@` files, `#` sessions, `/` commands, `$` skills.
 *
 * Detection is pure and runs on every caret move. A trigger starts at a token
 * boundary, so emails (`a@b`), C# and URL paths do not open a menu by accident.
 */
export type ComposerTriggerKind = 'file' | 'command' | 'session' | 'skill';
export type ComposerTriggerPrefix = '@' | '#' | '/' | '$';

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  prefix: ComposerTriggerPrefix;
  query: string;
  /** Offset of the prefix character. */
  start: number;
  /** Caret position; the token's end is always the caret. */
  end: number;
}

const PREFIX_KIND: Record<ComposerTriggerPrefix, ComposerTriggerKind> = {
  '@': 'file',
  '#': 'session',
  '/': 'command',
  '$': 'skill',
};

function isPrefix(value: string): value is ComposerTriggerPrefix {
  return value === '@' || value === '#' || value === '/' || value === '$';
}

/** The `@`, `#`, `/`, or `$` token ending at the caret; null outside one. */
export function detectTrigger(value: string, caret: number): ComposerTrigger | null {
  if (caret < 0 || caret > value.length) return null;
  const before = value.slice(0, caret);

  // Quoted file paths stay one token: @"my folder/file.ts"
  const quotedStart = before.lastIndexOf('@"');
  if (quotedStart >= 0 && before.indexOf('"', quotedStart + 2) < 0
    && !(quotedStart > 0 && /[\w@]/.test(value[quotedStart - 1]!))) {
    return { kind: 'file', prefix: '@', query: before.slice(quotedStart + 2), start: quotedStart, end: caret };
  }

  let start = caret;
  while (start > 0 && !/\s/u.test(value[start - 1]!)) start -= 1;
  const token = before.slice(start);
  if (token === '' || !isPrefix(token[0]!)) return null;
  // A token glued to a previous word (`a@b`, `C#`, `US$`) is prose, not a trigger.
  if (start > 0 && /[\w@#$]/u.test(value[start - 1]!)) return null;

  const prefix = token[0]!;
  const query = token.slice(1);
  if (prefix === '/' && (token.startsWith('//') || query.includes('/'))) return null;
  if (prefix === '$' && token.startsWith('${')) return null;
  if (prefix === '#' && token.startsWith('##')) return null;
  return { kind: PREFIX_KIND[prefix], prefix, query, start, end: caret };
}

export function replaceRange(value: string, start: number, end: number, replacement: string): {
  value: string;
  caret: number;
} {
  return { value: value.slice(0, start) + replacement + value.slice(end), caret: start + replacement.length };
}

export const fileReference = (path: string): string => /\s/u.test(path) ? `@"${path}" ` : `@${path} `;
export const directoryReference = (path: string): string => /\s/u.test(path) ? `@"${path}/` : `@${path}/`;
export const skillReference = (name: string): string => `$${name} `;
