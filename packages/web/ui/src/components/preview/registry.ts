/**
 * Kind → viewer table. Every preview type the workbench supports appears here
 * exactly once, so disabling one is a one-line change and the fallback (a
 * download card) is always reachable.
 */
import type { ComponentType } from 'react';
import type { PreviewKind } from './path.ts';
import type { ViewerProps } from './types.ts';
import { CodeViewer } from './viewers/CodeViewer.tsx';
import { DocxViewer } from './viewers/DocxViewer.tsx';
import { HtmlViewer } from './viewers/HtmlViewer.tsx';
import { ImageViewer } from './viewers/ImageViewer.tsx';
import { JsonViewer } from './viewers/JsonViewer.tsx';
import { MarkdownViewer } from './viewers/MarkdownViewer.tsx';
import { MediaViewer } from './viewers/MediaViewer.tsx';
import { PdfViewer } from './viewers/PdfViewer.tsx';
import { SheetViewer } from './viewers/SheetViewer.tsx';
import { TextViewer } from './viewers/TextViewer.tsx';
import { UnsupportedViewer } from './viewers/UnsupportedViewer.tsx';

/** The component contract every viewer satisfies. */
export type ViewerRenderer = ComponentType<ViewerProps>;

/** One viewer per classified kind. */
export const VIEWERS: Readonly<Record<PreviewKind, ViewerRenderer>> = {
  markdown: MarkdownViewer,
  code: CodeViewer,
  text: TextViewer,
  json: JsonViewer,
  image: ImageViewer,
  svg: ImageViewer,
  audio: MediaViewer,
  video: MediaViewer,
  pdf: PdfViewer,
  docx: DocxViewer,
  sheet: SheetViewer,
  html: HtmlViewer,
  unsupported: UnsupportedViewer,
};

/**
 * Resolve the viewer for a kind.
 * @param kind - classified preview kind.
 * @returns the viewer component; an unknown kind still yields the fallback card.
 */
export function viewerFor(kind: PreviewKind): ViewerRenderer {
  return VIEWERS[kind] ?? UnsupportedViewer;
}
