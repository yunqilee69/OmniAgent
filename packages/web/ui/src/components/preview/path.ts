/**
 * Filename-driven preview classification, mirroring how the vendored code
 * surfaces pick a grammar: the extension of the final path segment decides,
 * case insensitively, and the shared language table is the fallback so a
 * source file the highlighter knows never lands in the plain-text viewer.
 *
 * This module is deliberately free of React, shiki's highlighter, and the
 * viewer components: it is the one pure seam the preview tests import, and the
 * order of its checks is the routing contract (SVG before code, sheet before
 * code, markdown before code).
 */
import { CODE_HIGHLIGHT_EXTENSIONS } from '../../../vendor/util/code-language.ts';

/** One rendering strategy the preview surface can dispatch to. */
export type PreviewKind =
  | 'markdown'
  | 'code'
  | 'text'
  | 'json'
  | 'image'
  | 'svg'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'docx'
  | 'sheet'
  | 'html'
  | 'unsupported';

const MARKDOWN = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx']);
const JSON_EXTENSIONS = new Set(['json', 'jsonc', 'jsonl', 'ndjson', 'ipynb', 'webmanifest', 'geojson']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff']);
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus']);
const VIDEO = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv', 'mkv']);
const SHEET = new Set(['csv', 'tsv', 'psv']);
const WORKBOOK = new Set(['xlsx', 'xls', 'ods']);
const HTML = new Set(['html', 'htm', 'xhtml']);
const DOCX = new Set(['docx']);
const PDF = new Set(['pdf']);
const PLAIN_TEXT = new Set(['txt', 'text', 'log', 'rst', 'adoc', 'asciidoc', 'srt', 'vtt', 'org', 'tex', 'bib', 'rtf']);
/** Extensions the highlighter knows; kept as a Set for O(1) membership from the shared table. */
const CODE = new Set(CODE_HIGHLIGHT_EXTENSIONS);

/**
 * The lowercase suffix of the final path segment, or the whole dotfile name
 * (`/repo/.env` → `env`, `/repo/.gitignore` → `gitignore`).
 * @param path - workspace-relative path.
 * @returns the extension without its dot, or '' when the name has none.
 */
export function extensionOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The final path segment, used for the preview header and download filename. */
export function filenameOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash < 0 ? path : path.slice(slash + 1);
}

/** Everything before the final segment; '' for a root-level file. */
export function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/**
 * Classify one path. The first matching group wins, so a `.svg` never renders
 * as XML highlighting and a `.csv` never renders as CSV syntax highlighting.
 * @param path - workspace-relative path.
 * @returns the viewer that should render the file.
 */
export function previewKindFor(path: string): PreviewKind {
  const extension = extensionOf(path);
  if (extension === '') return 'text';
  if (PDF.has(extension)) return 'pdf';
  if (DOCX.has(extension)) return 'docx';
  if (WORKBOOK.has(extension) || SHEET.has(extension)) return 'sheet';
  if (IMAGE.has(extension)) return 'image';
  if (extension === 'svg') return 'svg';
  if (AUDIO.has(extension)) return 'audio';
  if (VIDEO.has(extension)) return 'video';
  if (HTML.has(extension)) return 'html';
  if (MARKDOWN.has(extension)) return 'markdown';
  if (JSON_EXTENSIONS.has(extension)) return 'json';
  if (CODE.has(extension)) return 'code';
  if (PLAIN_TEXT.has(extension)) return 'text';
  return 'unsupported';
}

/** Where a preview's body comes from. */
export type PreviewSource = 'text' | 'bytes' | 'url' | 'none';

/**
 * Which route a path's body comes from. Binary documents are parsed in the
 * client (`bytes`), media and PDF are rendered by the browser (`url`), and
 * everything textual — including CSV — is read through the UTF-8 route.
 * @param path - workspace-relative path.
 * @returns the source kind for that file.
 */
export function sourceForPath(path: string): PreviewSource {
  const extension = extensionOf(path);
  const kind = previewKindFor(path);
  if (kind === 'unsupported') return 'none';
  if (kind === 'docx' || WORKBOOK.has(extension)) return 'bytes';
  if (kind === 'text' || kind === 'markdown' || kind === 'code' || kind === 'json' || kind === 'html') return 'text';
  if (SHEET.has(extension)) return 'text';
  return 'url';
}

/**
 * Human-readable byte size for the preview header and size-limit messages.
 * @param bytes - size in bytes.
 * @returns e.g. `512 B`, `12.4 KB`, `3 MB`; `—` for a non-finite or negative value.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? String(Math.round(value)) : value.toFixed(1)} ${units[unit] ?? 'KB'}`;
}

/**
 * Join a relative reference onto a workspace directory.
 * @param baseDir - directory of the referencing file, workspace-relative.
 * @param destination - authored reference, possibly percent-encoded.
 * @returns a workspace-relative path, or undefined for URLs, absolute paths, and escapes.
 */
export function resolveRelativePath(baseDir: string, destination: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith('//')) return undefined;
  let decoded = destination;
  try { decoded = decodeURIComponent(destination); } catch { return undefined; }
  if (decoded.includes('\0')) return undefined;
  const stack = decoded.startsWith('/') || baseDir === '' ? [] : baseDir.split('/');
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) return undefined;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.length === 0 ? undefined : stack.join('/');
}
