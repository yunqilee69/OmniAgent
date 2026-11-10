/**
 * Delimited text (CSV/TSV/PSV) → rows, with RFC 4180 quoting.
 *
 * A preview needs the grid, not a spec-perfect reader: the parser handles
 * quoted fields, doubled quotes, embedded newlines, CRLF, and a BOM, then
 * stops at the row cap instead of building a table nobody will scroll.
 */
export interface DelimitedTable {
  rows: string[][];
  /** The delimiter actually used, for the toolbar label. */
  delimiter: string;
  truncated: boolean;
}

export interface DelimitedLimits {
  maxRows?: number;
  maxColumns?: number;
}

const DEFAULT_MAX_ROWS = 2000;
const DEFAULT_MAX_COLUMNS = 60;
const CANDIDATES = [',', '\t', ';', '|'] as const;

/**
 * Guess the delimiter from the first non-empty line.
 * @param text - the whole file.
 * @returns the most frequent candidate on that line, defaulting to a comma.
 */
export function detectDelimiter(text: string): string {
  const line = text.split('\n').find((entry) => entry.trim() !== '') ?? '';
  let best = ',';
  let bestCount = 0;
  for (const candidate of CANDIDATES) {
    const count = line.split(candidate).length - 1;
    if (count > bestCount) { best = candidate; bestCount = count; }
  }
  return best;
}

/**
 * Parse delimited text into a rectangular-ish matrix.
 * @param text - file body; a leading BOM is dropped.
 * @param options.delimiter - forced delimiter; detected when omitted.
 * @param options.maxRows - row cap, default 2,000.
 * @param options.maxColumns - column cap per row, default 60.
 * @returns rows, the delimiter used, and whether the cap cut the file short.
 */
export function parseDelimited(text: string, options: DelimitedLimits & { delimiter?: string } = {}): DelimitedTable {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxColumns = options.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = options.delimiter ?? detectDelimiter(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let truncated = false;

  let stopped = false;
  const endRow = (): boolean => {
    if (row.length < maxColumns) row.push(field);
    field = '';
    rows.push(row);
    row = [];
    if (rows.length >= maxRows) { truncated = true; return false; }
    return true;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; } else { quoted = false; }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === delimiter) {
      if (row.length < maxColumns) row.push(field);
      else truncated = true;
      field = '';
      continue;
    }
    if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      if (!endRow()) { stopped = true; break; }
      continue;
    }
    field += character;
  }
  // A file cut off by the row cap keeps the rows it filled, not a stray partial one.
  if (!stopped && (field !== '' || row.length > 0)) endRow();
  return { rows, delimiter, truncated };
}
