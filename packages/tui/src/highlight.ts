/** Small, dependency-free syntax highlighter for fenced code blocks. */
import type { Segment, Theme } from './ansi';
import { addStyle } from './ansi';

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  ts: new Set([
    'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
    'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface',
    'let', 'new', 'null', 'of', 'private', 'protected', 'public', 'readonly', 'return', 'satisfies',
    'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined',
    'var', 'void', 'while', 'with', 'yield',
  ]),
  js: new Set([
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete',
    'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import',
    'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'this',
    'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield',
  ]),
  py: new Set([
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
    'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
    'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while',
    'with', 'yield',
  ]),
  bash: new Set([
    'case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in', 'select',
    'then', 'until', 'while', 'export', 'local', 'readonly', 'return', 'shift', 'source', 'exit',
    'set', 'unset',
  ]),
  json: new Set(['true', 'false', 'null']),
  yaml: new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off']),
  css: new Set(['important', 'inherit', 'initial', 'unset', 'none', 'auto']),
};

function languageFamily(info: string): string {
  const language = info.trim().toLowerCase().split(/[\s:{]/)[0] ?? '';
  if (language === 'typescript' || language === 'tsx') return 'ts';
  if (language === 'javascript' || language === 'jsx' || language === 'mjs' || language === 'cjs') return 'js';
  if (language === 'python') return 'py';
  if (language === 'sh' || language === 'shell' || language === 'zsh') return 'bash';
  if (language === 'yml') return 'yaml';
  return language;
}

const STRING_PATTERN = /^(?:`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/;
const NUMBER_PATTERN = /^(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const WORD_PATTERN = /^[A-Za-z_$][\w$]*/;

/** Highlight one line of code; unknown languages fall back to plain text. */
export function highlightCode(line: string, language: string, theme: Theme): string {
  const family = languageFamily(language);
  if (family === 'diff' || family === 'patch') return highlightDiff(line, theme);
  if (!theme.enabled) return line;

  const keywords = KEYWORDS[family];
  const segments: Segment[] = [];
  const push = (text: string, style: Segment['style']): void => {
    if (text.length > 0) segments.push({ text, style });
  };

  let index = 0;
  while (index < line.length) {
    const rest = line.slice(index);

    const comment = commentAt(rest, family);
    if (comment !== undefined) {
      push(comment, { dim: true, fg: 'gray', italic: true });
      break;
    }

    const string = STRING_PATTERN.exec(rest);
    if (string !== null) {
      const value = string[0];
      // JSON object keys read better in the accent color than as plain strings.
      const isKey = family === 'json' && /^\s*:/.test(line.slice(index + value.length));
      push(value, isKey ? { fg: 'brightCyan' } : { fg: 'green' });
      index += value.length;
      continue;
    }

    const number = NUMBER_PATTERN.exec(rest);
    if (number !== null && !/[\w$]/.test(line[index - 1] ?? '')) {
      push(number[0], { fg: 'brightYellow' });
      index += number[0].length;
      continue;
    }

    const word = WORD_PATTERN.exec(rest);
    if (word !== null) {
      const value = word[0];
      if (family === 'bash' && value.startsWith('$')) push(value, { fg: 'brightCyan' });
      else if (keywords?.has(value)) push(value, { fg: 'brightMagenta' });
      else if (family === 'yaml' && /^\s*:/.test(line.slice(index + value.length))) push(value, { fg: 'brightCyan' });
      else push(value, {});
      index += value.length;
      continue;
    }

    if (family === 'bash' && rest.startsWith('$')) {
      const variable = /^\$\{?[A-Za-z_][\w]*\}?/.exec(rest);
      if (variable !== null) {
        push(variable[0], { fg: 'brightCyan' });
        index += variable[0].length;
        continue;
      }
    }

    push(line[index] ?? '', {});
    index += 1;
  }

  return theme.segments(segments);
}

function commentAt(rest: string, family: string): string | undefined {
  if ((family === 'ts' || family === 'js' || family === 'go' || family === 'rust' || family === 'java')
    && (rest.startsWith('//') || rest.startsWith('/*') || rest.startsWith('*'))) {
    return rest;
  }
  if ((family === 'py' || family === 'bash' || family === 'yaml' || family === 'ruby' || family === 'toml')
    && rest.startsWith('#')) {
    return rest;
  }
  return undefined;
}

function highlightDiff(line: string, theme: Theme): string {
  const style = line.startsWith('+') && !line.startsWith('+++')
    ? { fg: 'green' as const }
    : line.startsWith('-') && !line.startsWith('---')
      ? { fg: 'red' as const }
      : line.startsWith('@@')
        ? { fg: 'brightCyan' as const }
        : line.startsWith('diff ') || line.startsWith('index ')
          ? { dim: true as const }
          : {};
  return theme.segments(addStyle([{ text: line, style: {} }], style));
}
