/**
 * 流式 Markdown 渲染。
 *
 * 模型按 chunk 吐字，所以这里按「完整行」处理：chunk 只是往缓冲区追加，
 * 遇到换行才解析。这样 **粗体**、`代码`、表格和代码块都不会被切碎。
 * 行内样式先解析成 Segment，再统一上色，避免嵌套 ANSI reset 互相踩踏。
 */
import type { Segment, Style, Theme } from './ansi';
import { addStyle, codePointWidth, displayWidth, truncateDisplay } from './ansi';
import { highlightCode } from './highlight';

export interface MarkdownOptions {
  theme: Theme;
  /** Terminal width in columns, or a getter for the live window size. */
  width?: number | (() => number);
  /** Applied to every content segment; reasoning uses dim. */
  baseStyle?: Style;
  /** Prefix for every physical line, e.g. the thinking rail. */
  linePrefix?: string;
}

interface FenceState {
  char: string;
  length: number;
  info: string;
  lines: string[];
}

const LIST_PATTERN = /^(\s*)([-+*]|\d+[.)])[ \t]+(.*)$/;
const HEADING_PATTERN = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const HR_PATTERN = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const QUOTE_PATTERN = /^(?: {0,3}>[ \t]?)+(.*)$/;

export class MarkdownStream {
  private buffer = '';
  private fence: FenceState | undefined;
  private table: string[] = [];

  constructor(
    private readonly write: (chunk: string) => void,
    private readonly options: MarkdownOptions,
  ) {}

  push(chunk: string): void {
    if (chunk.length === 0) return;
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.processLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  end(): void {
    if (this.buffer.length > 0) {
      this.processLine(this.buffer);
      this.buffer = '';
    }
    if (this.fence) this.flushFence();
    if (this.table.length > 0) this.flushTable();
  }

  private get width(): number {
    const width = typeof this.options.width === 'function' ? this.options.width() : this.options.width;
    return Math.max(24, width ?? 100);
  }

  private get prefix(): string {
    return this.options.linePrefix ?? '';
  }

  private get prefixWidth(): number {
    return displayWidth(this.prefix);
  }

  private processLine(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (this.fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close !== null && close[1]?.[0] === this.fence.char && close[1].length >= this.fence.length) {
        this.flushFence();
        return;
      }
      this.fence.lines.push(line);
      return;
    }

    const fence = FENCE_PATTERN.exec(line);
    if (fence !== null) {
      this.flushTable();
      this.fence = { char: fence[1]?.[0] ?? '`', length: fence[1]?.length ?? 3, info: fence[2]?.trim() ?? '', lines: [] };
      return;
    }

    if (looksLikeTableRow(line)) {
      this.table.push(line);
      return;
    }
    if (this.table.length > 0) this.flushTable();

    if (line.trim().length === 0) {
      this.emitPlain('');
      return;
    }

    const heading = HEADING_PATTERN.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      const style: Style = level === 1
        ? { bold: true, underline: true, fg: 'brightCyan' }
        : level === 2 ? { bold: true, fg: 'brightCyan' } : { bold: true };
      this.emitWrapped(addStyle(this.inline(heading[2] ?? ''), style), [], []);
      return;
    }

    if (HR_PATTERN.test(line)) {
      this.emitPlain(this.theme.paint('─'.repeat(Math.max(8, Math.min(this.width - this.prefixWidth - 2, 48))), { dim: true }));
      return;
    }

    const quote = QUOTE_PATTERN.exec(line);
    if (quote !== null) {
      const rail = [{ text: '  │ ', style: { dim: true } satisfies Style }];
      this.emitWrapped(addStyle(this.inline(quote[1] ?? ''), { dim: true, italic: true }), rail, rail);
      return;
    }

    const list = LIST_PATTERN.exec(line);
    if (list !== null) {
      this.emitList(list[1] ?? '', list[2] ?? '-', list[3] ?? '');
      return;
    }

    // Indented code blocks: keep the text but make it visually distinct.
    if (/^(?: {4}|\t)/.test(line)) {
      const body = line.replace(/^(?: {4}|\t)/, '');
      const border = this.theme.paint('  │ ', { dim: true });
      this.write(`${this.prefix}${border}${this.theme.paint(body, { dim: true })}\n`);
      return;
    }

    this.emitWrapped(this.inline(line), [{ text: '', style: {} }], [{ text: '', style: {} }]);
  }

  private get theme(): Theme {
    return this.options.theme;
  }

  private inline(text: string): Segment[] {
    const segments = parseInline(text);
    return this.options.baseStyle === undefined ? segments : addStyle(segments, this.options.baseStyle);
  }

  private emitList(leading: string, marker: string, content: string): void {
    const indent = `${leading.replace(/\t/g, '  ')}  `;
    let bullet = /^\d/.test(marker) ? `${marker.replace(/[.)]$/, '.')} ` : '• ';
    let body = content;
    const task = /^\[([ xX])\][ \t]+(.*)$/.exec(body);
    if (task !== null) {
      bullet = task[1]?.toLowerCase() === 'x' ? '☑ ' : '☐ ';
      body = task[2] ?? '';
    }
    const markerStyle: Style = { dim: true };
    const first = [
      { text: indent, style: {} },
      { text: bullet, style: markerStyle },
    ];
    const rest = [
      { text: indent + ' '.repeat(displayWidth(bullet)), style: {} },
    ];
    this.emitWrapped(this.inline(body), first, rest);
  }

  private emitWrapped(segments: Segment[], firstPrefix: Segment[], restPrefix: Segment[]): void {
    const prefixWidth = displayWidth(firstPrefix.map((segment) => segment.text).join('')) + this.prefixWidth;
    const width = Math.max(8, this.width - prefixWidth);
    const lines = wrapSegments(segments, width);
    if (lines.length === 0) {
      this.write(`${this.prefix}${this.theme.segments(firstPrefix)}\n`);
      return;
    }
    lines.forEach((line, index) => {
      const prefix = index === 0 ? firstPrefix : restPrefix;
      const needsPrefix = prefix.some((segment) => segment.text.length > 0);
      this.write(`${this.prefix}${needsPrefix ? this.theme.segments(prefix) : ''}${this.theme.segments(line)}\n`);
    });
  }

  private emitPlain(text: string): void {
    this.write(text.length === 0 ? '\n' : `${this.prefix}${text}\n`);
  }

  private flushFence(): void {
    const fence = this.fence;
    this.fence = undefined;
    if (fence === undefined) return;
    const language = fence.info.split(/\s+/)[0] ?? '';
    const label = language.length > 0 ? language : 'code';
    const contentWidth = Math.max(...fence.lines.map((line) => displayWidth(line)), 8);
    const available = Math.max(12, this.width - this.prefixWidth - 4);
    const rule = Math.max(8, Math.min(contentWidth + 2, available));
    const heading = `  ╭─ ${label} ${'─'.repeat(Math.max(0, rule - label.length - 4))}`;
    this.emitPlain(this.theme.paint(heading, { dim: true }));
    for (const line of fence.lines) {
      if (this.options.baseStyle === undefined) {
        this.write(`${this.prefix}${this.theme.paint('  │ ', { dim: true })}${highlightCode(line, language, this.theme)}\n`);
      } else {
        this.write(`${this.prefix}${this.theme.paint('  │ ', { dim: true })}${this.theme.paint(line, { ...this.options.baseStyle, dim: true })}\n`);
      }
    }
    this.emitPlain(this.theme.paint(`  ╰${'─'.repeat(rule)}`, { dim: true }));
  }

  private flushTable(): void {
    const lines = this.table;
    this.table = [];
    if (lines.length === 0) return;

    const rows = lines.map(parseTableRow).filter((cells) => cells.length > 0);
    if (rows.length === 0) return;
    const separatorIndex = rows.findIndex((cells) => cells.every(isSeparatorCell));
    const hasHeader = separatorIndex >= 1;
    const body = hasHeader ? rows.filter((_, index) => index !== separatorIndex) : rows;
    if (body.length === 0) return;

    const columns = Math.max(...body.map((row) => row.length));
    if (!hasHeader || columns < 2) {
      for (const row of rows) this.emitWrapped(this.inline(row.join(' · ')), [{ text: '', style: {} }], [{ text: '', style: {} }]);
      return;
    }

    const alignments = rows[separatorIndex]?.map((cell) => {
      const value = cell.trim();
      if (value.startsWith(':') && value.endsWith(':')) return 'center' as const;
      if (value.endsWith(':')) return 'right' as const;
      return 'left' as const;
    }) ?? [];
    const cells = body.map((row) => Array.from({ length: columns }, (_, index) => this.inline(row[index] ?? '')));
    const widths = Array.from({ length: columns }, (_, column) => Math.max(
      3,
      ...cells.map((row) => displayWidth((row[column] ?? []).map((segment) => segment.text).join(''))),
    ));
    const needed = widths.reduce((total, width) => total + width, 0) + columns * 5 + 1;
    if (needed > this.width - this.prefixWidth) {
      for (const row of body) this.emitWrapped(this.inline(row.join(' · ')), [{ text: '', style: {} }], [{ text: '', style: {} }]);
      return;
    }

    const dim = (text: string): string => this.theme.paint(text, { dim: true });
    for (const [rowIndex, row] of cells.entries()) {
      const parts: string[] = [];
      for (const [column, width] of widths.entries()) {
        const cell = row[column] ?? [];
        const padding = Math.max(0, width - displayWidth(cell.map((segment) => segment.text).join('')));
        const alignment = alignments[column] ?? 'left';
        const left = alignment === 'right' ? padding : alignment === 'center' ? Math.floor(padding / 2) : 0;
        const right = padding - left;
        const padded: Segment[] = [
          { text: ' '.repeat(left), style: {} },
          ...cell,
          { text: ' '.repeat(right), style: {} },
        ];
        parts.push(this.theme.segments(rowIndex === 0 ? addStyle(padded, { bold: true }) : padded));
      }
      this.write(`${this.prefix}${dim('│')} ${parts.join(` ${dim('│')} `)} ${dim('│')}\n`);
      if (rowIndex === 0 && body.length > 1) {
        this.write(`${this.prefix}${dim(`├${widths.map((width) => '─'.repeat(width + 2)).join('┼')}┤`)}\n`);
      }
    }
  }
}

export function renderMarkdown(text: string, options: MarkdownOptions): string {
  let output = '';
  const stream = new MarkdownStream((chunk) => { output += chunk; }, options);
  stream.push(text);
  stream.end();
  return output;
}

/** Parse inline Markdown into styled segments without interpreting block syntax. */
export function parseInline(text: string): Segment[] {
  const segments: Segment[] = [];
  let index = 0;
  const push = (value: string, style: Style = {}): void => {
    if (value.length > 0) segments.push({ text: value, style });
  };

  while (index < text.length) {
    const char = text[index] ?? '';
    const rest = text.slice(index);

    if (char === '\\' && index + 1 < text.length) {
      push(text[index + 1] ?? '');
      index += 2;
      continue;
    }

    if (char === '`') {
      const run = countRun(text, index, '`');
      const close = findRun(text, index + run, '`', run);
      if (close !== -1) {
        let content = text.slice(index + run, close);
        if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim().length > 0) {
          content = content.slice(1, -1);
        }
        push(content, { fg: 'brightYellow' });
        index = close + run;
        continue;
      }
    }

    if (char === '!' && text[index + 1] === '[') {
      const link = parseLinkAt(text, index + 1);
      if (link !== undefined) {
        push('🖼 ', { dim: true });
        push(link.label.length > 0 ? link.label : '图片', { fg: 'brightCyan', underline: true });
        if (link.destination.length > 0) push(` (${link.destination})`, { dim: true });
        index = link.end;
        continue;
      }
    }

    if (char === '[') {
      const link = parseLinkAt(text, index);
      if (link !== undefined) {
        push(link.label, { fg: 'brightCyan', underline: true });
        if (link.destination.length > 0 && link.destination !== link.label) {
          push(` (${link.destination})`, { dim: true });
        }
        index = link.end;
        continue;
      }
    }

    if (char === '<') {
      const autolink = /^<((?:https?|mailto):[^>\s]+)>/.exec(rest);
      if (autolink !== null) {
        push(autolink[1] ?? '', { fg: 'brightCyan', underline: true });
        index += autolink[0].length;
        continue;
      }
      const tag = /^<\/?[A-Za-z][^>]*>/.exec(rest);
      if (tag !== null) {
        index += tag[0].length;
        continue;
      }
    }

    if ((char === '*' || char === '_') && text[index + 1] === char) {
      const close = findMarker(text, index + 2, char + char);
      if (close > index + 2 && !/\s/.test(text[index + 2] ?? '')) {
        segments.push(...addStyle(parseInline(text.slice(index + 2, close)), { bold: true }));
        index = close + 2;
        continue;
      }
    }

    if (char === '~' && text[index + 1] === '~') {
      const close = findMarker(text, index + 2, '~~');
      if (close > index + 2) {
        segments.push(...addStyle(parseInline(text.slice(index + 2, close)), { strike: true }));
        index = close + 2;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      const close = findMarker(text, index + 1, char);
      if (close > index + 1 && !/\s/.test(text[index + 1] ?? '')) {
        segments.push(...addStyle(parseInline(text.slice(index + 1, close)), { italic: true }));
        index = close + 1;
        continue;
      }
    }

    if (char === 'h' && /^https?:\/\//.test(rest)) {
      const url = /^https?:\/\/[^\s<>()]+/.exec(rest);
      if (url !== null) {
        push(url[0], { fg: 'brightCyan', underline: true });
        index += url[0].length;
        continue;
      }
    }

    push(char);
    index += 1;
  }

  return segments;
}

interface ParsedLink {
  label: string;
  destination: string;
  end: number;
}

function parseLinkAt(text: string, open: number): ParsedLink | undefined {
  if (text[open] !== '[') return undefined;
  let depth = 0;
  let close = -1;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '[') depth += 1;
    else if (text[index] === ']') {
      depth -= 1;
      if (depth === 0) { close = index; break; }
    }
  }
  if (close === -1 || text[close + 1] !== '(') return undefined;
  let parens = 1;
  let end = -1;
  for (let index = close + 2; index < text.length; index += 1) {
    if (text[index] === '(') parens += 1;
    else if (text[index] === ')') {
      parens -= 1;
      if (parens === 0) { end = index; break; }
    }
  }
  if (end === -1) return undefined;
  const destination = text.slice(close + 2, end).trim().split(/\s+/)[0]?.replace(/^<|>$/g, '') ?? '';
  return { label: text.slice(open + 1, close), destination, end: end + 1 };
}

function countRun(text: string, start: number, char: string): number {
  let index = start;
  while (text[index] === char) index += 1;
  return index - start;
}

function findRun(text: string, start: number, char: string, length: number): number {
  const marker = char.repeat(length);
  let index = text.indexOf(marker, start);
  while (index !== -1) {
    if (text[index - 1] !== '\\' && text[index + length] !== char) return index;
    index = text.indexOf(marker, index + length);
  }
  return -1;
}

function findMarker(text: string, start: number, marker: string): number {
  let index = text.indexOf(marker, start);
  while (index !== -1) {
    if (text[index - 1] !== '\\') return index;
    index = text.indexOf(marker, index + marker.length);
  }
  return -1;
}

function looksLikeTableRow(line: string): boolean {
  if (!line.includes('|')) return false;
  if (HEADING_PATTERN.test(line) || LIST_PATTERN.test(line) || FENCE_PATTERN.test(line)) return false;
  return true;
}

function parseTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      current += char;
      escaped = true;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isSeparatorCell(cell: string): boolean {
  return /^:?-{1,}:?$/.test(cell.replace(/\s/g, ''));
}

interface Token {
  text: string;
  style: Style;
  space: boolean;
  wide: boolean;
}

/** Greedy display-width wrap that preserves styles and CJK boundaries. */
export function wrapSegments(segments: readonly Segment[], width: number): Segment[][] {
  const limit = Math.max(1, width);
  const tokens: Token[] = [];
  for (const segment of segments) {
    let word = '';
    const flushWord = (): void => {
      if (word.length > 0) {
        tokens.push({ text: word, style: segment.style, space: false, wide: false });
        word = '';
      }
    };
    for (const char of segment.text) {
      const code = char.codePointAt(0) ?? 0;
      if (/\s/.test(char)) {
        flushWord();
        tokens.push({ text: char === '\t' ? '  ' : char, style: segment.style, space: true, wide: false });
      } else if (codePointWidth(code) === 2) {
        flushWord();
        tokens.push({ text: char, style: segment.style, space: false, wide: true });
      } else {
        word += char;
      }
    }
    flushWord();
  }

  const lines: Token[][] = [];
  let line: Token[] = [];
  let used = 0;
  const flush = (): void => {
    while (line.at(-1)?.space === true) line.pop();
    lines.push(line);
    line = [];
    used = 0;
  };

  for (const token of tokens) {
    const size = displayWidth(token.text);
    if (token.space) {
      if (line.length === 0) continue;
      line.push(token);
      used += size;
      continue;
    }
    if (used + size > limit && line.length > 0) flush();
    if (size > limit) {
      for (const char of token.text) {
        const charSize = codePointWidth(char.codePointAt(0) ?? 0);
        if (used + charSize > limit && line.length > 0) flush();
        line.push({ text: char, style: token.style, space: false, wide: charSize === 2 });
        used += charSize;
      }
      continue;
    }
    line.push(token);
    used += size;
  }
  if (line.length > 0) flush();

  return lines.map((tokensLine) => {
    const segmentsLine: Segment[] = [];
    for (const token of tokensLine) {
      const previous = segmentsLine.at(-1);
      if (previous !== undefined && sameStyle(previous.style, token.style)) previous.text += token.text;
      else segmentsLine.push({ text: token.text, style: token.style });
    }
    return segmentsLine;
  });
}

function sameStyle(left: Style, right: Style): boolean {
  return left.bold === right.bold && left.dim === right.dim && left.italic === right.italic
    && left.underline === right.underline && left.strike === right.strike && left.fg === right.fg;
}

export { truncateDisplay };
