/**
 * `.xlsx` → sheet tables, straight from the OOXML parts.
 *
 * A preview shows the grid, so shared strings are resolved and sparse cells
 * are placed by their A1 reference; number formats, formulas, and charts are
 * out of scope. Rows and columns are capped rather than rendered unbounded.
 */
import { childrenNamed, parseXml, unzipSelected } from './zip.ts';

export interface SheetTable {
  name: string;
  rows: string[][];
  /** Whether the sheet had more rows or columns than the cap. */
  truncated: boolean;
}

export interface XlsxPreview {
  sheets: SheetTable[];
}

export interface XlsxLimits {
  maxRows?: number;
  maxColumns?: number;
}

const DEFAULT_MAX_ROWS = 2000;
const DEFAULT_MAX_COLUMNS = 60;

function columnIndex(reference: string): number {
  let index = 0;
  for (const character of reference) {
    const code = character.toUpperCase().charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

function rowIndex(reference: string, fallback: number): number {
  const digits = /\d+/.exec(reference);
  if (digits === null) return fallback;
  const value = Number(digits[0]);
  return Number.isSafeInteger(value) && value > 0 ? value - 1 : fallback;
}

function sharedStrings(document: Document | undefined): string[] {
  if (document === undefined) return [];
  return Array.from(document.getElementsByTagName('si')).map((item) =>
    Array.from(item.getElementsByTagName('t')).map((node) => node.textContent ?? '').join(''));
}

function relationships(document: Document | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (document === undefined) return map;
  for (const relationship of Array.from(document.getElementsByTagName('Relationship'))) {
    const id = relationship.getAttribute('Id');
    const target = relationship.getAttribute('Target');
    if (id !== null && target !== null) map.set(id, target);
  }
  return map;
}

function workbookSheets(document: Document | undefined): Array<{ name: string; target: string | undefined }> {
  if (document === undefined) return [];
  return Array.from(document.getElementsByTagName('sheet')).map((sheet) => ({
    name: sheet.getAttribute('name') ?? 'Sheet',
    target: sheet.getAttribute('r:id') ?? undefined,
  }));
}

function cellText(cell: Element, strings: readonly string[]): string {
  const type = cell.getAttribute('t') ?? '';
  if (type === 'inlineStr') {
    const inline = childrenNamed(cell, 'is')[0];
    return inline === undefined
      ? ''
      : Array.from(inline.getElementsByTagName('t')).map((node) => node.textContent ?? '').join('');
  }
  const value = childrenNamed(cell, 'v')[0]?.textContent ?? '';
  if (type === 's') {
    const index = Number(value);
    return Number.isInteger(index) ? (strings[index] ?? '') : '';
  }
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
  return value;
}

function sheetRows(
  document: Document | undefined,
  strings: readonly string[],
  limits: Required<XlsxLimits>,
): { rows: string[][]; truncated: boolean } {
  const table: string[][] = [];
  let truncated = false;
  const sheetData = document?.getElementsByTagName('sheetData')[0];
  if (sheetData === undefined) return { rows: table, truncated };
  let fallbackRow = 0;
  for (const row of childrenNamed(sheetData, 'row')) {
    const index = rowIndex(row.getAttribute('r') ?? '', fallbackRow);
    fallbackRow = index + 1;
    if (index >= limits.maxRows) { truncated = true; break; }
    const cells: string[] = [];
    for (const cell of childrenNamed(row, 'c')) {
      const column = columnIndex(cell.getAttribute('r') ?? '');
      if (column < 0) continue;
      if (column >= limits.maxColumns) { truncated = true; continue; }
      while (cells.length < column) cells.push('');
      cells[column] = cellText(cell, strings);
    }
    while (table.length < index) table.push([]);
    table[index] = cells;
  }
  return { rows: table, truncated };
}

/**
 * Read every sheet of one workbook.
 * @param bytes - the whole `.xlsx` container.
 * @param limits - row and column caps; both default to a side-panel-friendly grid.
 * @returns sheets in workbook order.
 * @throws when the container is not a readable workbook.
 */
export async function readXlsx(bytes: Uint8Array, limits: XlsxLimits = {}): Promise<XlsxPreview> {
  const capRows = limits.maxRows ?? DEFAULT_MAX_ROWS;
  const capColumns = limits.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const entries = await unzipSelected(bytes, (name) =>
    name === 'xl/workbook.xml'
    || name === 'xl/_rels/workbook.xml.rels'
    || name === 'xl/sharedStrings.xml'
    || /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  const workbook = parseXml(entries, 'xl/workbook.xml');
  if (workbook === undefined) throw new Error('This workbook could not be read.');
  const strings = sharedStrings(parseXml(entries, 'xl/sharedStrings.xml'));
  const rels = relationships(parseXml(entries, 'xl/_rels/workbook.xml.rels'));
  const sheets: SheetTable[] = [];
  for (const sheet of workbookSheets(workbook)) {
    const target = sheet.target === undefined ? undefined : rels.get(sheet.target);
    const entryName = target === undefined ? undefined : (target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    const document = entryName === undefined ? undefined : parseXml(entries, entryName);
    const { rows, truncated } = sheetRows(document, strings, { maxRows: capRows, maxColumns: capColumns });
    sheets.push({ name: sheet.name, rows, truncated });
  }
  return { sheets };
}
