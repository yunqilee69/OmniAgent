/**
 * 终端样式与文本宽度的小工具。
 *
 * 这里不引入 chalk：TUI 只需要十几个固定的 SGR 码，自己拼反而能把
 * 「哪些字符是样式、哪些是内容」分清楚，测试也稳定。
 */

export type AnsiColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan';

export interface Style {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fg?: AnsiColor;
}

export interface Segment {
  text: string;
  style: Style;
}

const FG_CODES: Record<AnsiColor, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
};

/** Color decision shared by the theme and `/color`, kept pure for tests. */
export function colorEnabled(options: ThemeOptions = {}): boolean {
  const env = options.env ?? process.env;
  const forced = env['FORCE_COLOR'];
  if (options.enabled !== undefined) return options.enabled;
  return env['NO_COLOR'] === undefined
    && forced !== '0'
    && env['TERM'] !== 'dumb'
    && (options.isTTY === true || (forced !== undefined && forced !== ''));
}

export interface Theme {
  /** Live switch: `/color` flips this without rebuilding every consumer. */
  enabled: boolean;
  paint(text: string, style?: Style): string;
  segments(segments: readonly Segment[]): string;
}

export interface ThemeOptions {
  enabled?: boolean;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Color only when attached to a terminal, unless NO_COLOR/FORCE_COLOR says otherwise. */
export function createTheme(options: ThemeOptions = {}): Theme {
  const theme: Theme = {
    enabled: colorEnabled(options),
    paint(text, style) {
      if (!theme.enabled || style === undefined) return text;
      const codes = styleCodes(style);
      return codes.length === 0 ? text : `\x1b[${codes.join(';')}m${text}\x1b[0m`;
    },
    segments(segments) {
      return paintSegments(segments, theme.enabled);
    },
  };
  return theme;
}

export function mergeStyle(base: Style, extra: Style): Style {
  return { ...base, ...extra };
}

export function addStyle(segments: readonly Segment[], extra: Style): Segment[] {
  return segments.map((segment) => ({ text: segment.text, style: mergeStyle(segment.style, extra) }));
}

export function emptyStyle(style: Style): boolean {
  return !style.bold && !style.dim && !style.italic && !style.underline && !style.strike && style.fg === undefined;
}

function styleCodes(style: Style): number[] {
  const codes: number[] = [];
  if (style.bold) codes.push(1);
  if (style.dim) codes.push(2);
  if (style.italic) codes.push(3);
  if (style.underline) codes.push(4);
  if (style.strike) codes.push(9);
  if (style.fg !== undefined) codes.push(FG_CODES[style.fg]);
  return codes;
}

function paintSegments(segments: readonly Segment[], enabled: boolean): string {
  if (!enabled) return segments.map((segment) => segment.text).join('');
  let output = '';
  for (const segment of segments) {
    if (segment.text.length === 0) continue;
    const codes = styleCodes(segment.style);
    output += codes.length === 0
      ? segment.text
      : `\x1b[${codes.join(';')}m${segment.text}\x1b[0m`;
  }
  return output;
}

/** Remove SGR sequences so width calculations see text only. */
export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Display width in terminal cells; CJK and emoji count as two cells. */
export function displayWidth(value: string): number {
  const text = stripAnsi(value);
  let width = 0;
  for (const char of text) {
    width += codePointWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

export function codePointWidth(code: number): number {
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  // Combining marks and zero-width joiners do not occupy a cell.
  if (code === 0x200d || code === 0xfe0f || (code >= 0x0300 && code <= 0x036f)) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0x303e)
    || (code >= 0x3041 && code <= 0x33ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xa000 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff)
    || (code >= 0x20000 && code <= 0x3fffd)
  ) return 2;
  return 1;
}

/** Truncate to a display width, appending an ellipsis when text was removed. */
export function truncateDisplay(value: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(value) <= width) return value;
  let output = '';
  let used = 0;
  for (const char of stripAnsi(value)) {
    const size = codePointWidth(char.codePointAt(0) ?? 0);
    if (used + size > Math.max(0, width - 1)) break;
    output += char;
    used += size;
  }
  return `${output}…`;
}

/** Keep only the last `count` visual lines, never splitting a wide character. */
export function tailLines(value: string, count: number): string[] {
  const lines = value.split('\n');
  return count <= 0 ? [] : lines.slice(-count);
}

export { ANSI_PATTERN };
