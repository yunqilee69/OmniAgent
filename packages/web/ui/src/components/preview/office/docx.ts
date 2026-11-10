/**
 * `.docx` → block model, straight from `word/document.xml`.
 *
 * WordprocessingML is huge; a preview needs the reading order, not the layout
 * engine. This keeps headings, paragraphs, list items, alignment, tabs and
 * tables — the structure a reader actually scans — and reports how much it
 * could not show. Legacy binary `.doc` never reaches here.
 */
import { childrenNamed, parseXml, unzipSelected } from './zip.ts';

/** One renderable block of a Word document body. */
export type DocxBlock =
  | { kind: 'heading'; depth: number; text: string }
  | { kind: 'paragraph'; text: string; list: boolean; align: string | undefined }
  | { kind: 'table'; rows: string[][] };

export interface DocxPreview {
  blocks: DocxBlock[];
  images: number;
  truncated: boolean;
}

/** Upper bound on rendered blocks; a 300-page manual stops being useful in a side panel. */
const MAX_BLOCKS = 4000;

function paragraphText(paragraph: Element): string {
  let text = '';
  const walk = (node: Element): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      const element = child as Element;
      const name = element.nodeName;
      if (name === 'w:t') { text += element.textContent ?? ''; continue; }
      if (name === 'w:tab') { text += '\t'; continue; }
      if (name === 'w:br' || name === 'w:cr') { text += '\n'; continue; }
      // Deleted runs and field codes are not part of the visible document.
      if (name === 'w:del' || name === 'w:instrText') continue;
      walk(element);
    }
  };
  walk(paragraph);
  return text;
}

function property(paragraph: Element, parent: string, child: string): string | undefined {
  const container = childrenNamed(paragraph, parent)[0];
  if (container === undefined) return undefined;
  const element = childrenNamed(container, child)[0];
  return element?.getAttribute('w:val') ?? undefined;
}

function headingDepth(paragraph: Element): number | undefined {
  const style = property(paragraph, 'w:pPr', 'w:pStyle') ?? '';
  if (/^title$/i.test(style)) return 1;
  const named = /^heading(\d)$/i.exec(style);
  if (named !== null) return Math.min(6, Math.max(1, Number(named[1])));
  const outline = property(paragraph, 'w:pPr', 'w:outlineLvl');
  if (outline !== undefined) {
    const level = Number(outline);
    if (Number.isInteger(level) && level >= 0) return Math.min(6, level + 1);
  }
  return undefined;
}

function isListItem(paragraph: Element): boolean {
  const pPr = childrenNamed(paragraph, 'w:pPr')[0];
  return pPr !== undefined && childrenNamed(pPr, 'w:numPr').length > 0;
}

function tableRows(table: Element): string[][] {
  return childrenNamed(table, 'w:tr').map((row) => childrenNamed(row, 'w:tc').map((cell) =>
    childrenNamed(cell, 'w:p').map((paragraph) => paragraphText(paragraph).trim()).filter(Boolean).join(' ')));
}

/**
 * Read a Word document body into blocks.
 * @param bytes - the whole `.docx` container.
 * @returns blocks in reading order, plus what the preview could not render.
 * @throws when the container is not a readable Word document.
 */
export async function readDocx(bytes: Uint8Array): Promise<DocxPreview> {
  const entries = await unzipSelected(bytes, (name) => name === 'word/document.xml' || name.startsWith('word/media/'));
  const document = parseXml(entries, 'word/document.xml');
  if (document === undefined) throw new Error('This document could not be read.');
  const body = document.getElementsByTagName('w:body')[0] ?? document.documentElement;
  const blocks: DocxBlock[] = [];
  let truncated = false;
  for (const element of childrenNamed(body, 'w:p', 'w:tbl')) {
    if (blocks.length >= MAX_BLOCKS) { truncated = true; break; }
    if (element.nodeName === 'w:tbl') {
      const rows = tableRows(element).filter((row) => row.length > 0);
      if (rows.length > 0) blocks.push({ kind: 'table', rows });
      continue;
    }
    const text = paragraphText(element).trim();
    if (text === '') continue;
    const depth = headingDepth(element);
    if (depth !== undefined) { blocks.push({ kind: 'heading', depth, text }); continue; }
    blocks.push({ kind: 'paragraph', text, list: isListItem(element), align: property(element, 'w:pPr', 'w:jc') });
  }
  const images = [...entries.keys()].filter((name) => name.startsWith('word/media/')).length;
  return { blocks, images, truncated };
}
