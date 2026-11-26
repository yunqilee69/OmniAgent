import { z } from 'zod';

/**
 * A confirmed development plan is a versioned document on the root session.
 *
 * The body is the specification: modules, interfaces, invariants, and the
 * delivery slices the board is cut from. It has no task status. Status lives
 * on the team board, which cites a plan id, version, and heading.
 */

export const PLAN_DOCUMENT_EVENT = 'plan/document';

export const PLAN_DOCUMENT_MAX_CHARS = 200_000;
export const PLAN_HEADING_MAX_CHARS = 200;

export const PlanDocumentSchema = z.object({
  id: z.string().regex(/^plan-\d+$/u),
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(PLAN_HEADING_MAX_CHARS),
  body: z.string().trim().min(1).max(PLAN_DOCUMENT_MAX_CHARS),
  confirmedAt: z.number().int().nonnegative(),
}).strict();
export type PlanDocument = z.infer<typeof PlanDocumentSchema>;

export interface PlanDocumentView {
  id: string;
  version: number;
  title: string;
  body: string;
  confirmedAt: number;
}

interface PlanFold {
  documents: Map<string, PlanDocument>;
  nextNumber: number;
}

/** Latest version of every plan, in creation order. A malformed record is skipped. */
export function projectPlanDocuments(
  events: readonly { type: string; data: unknown }[],
): PlanDocumentView[] {
  const fold = foldPlanDocuments(events);
  return [...fold.documents.values()].map(toView);
}

export function projectPlanDocument(
  events: readonly { type: string; data: unknown }[],
  id: string,
  version?: number,
): PlanDocumentView | undefined {
  if (version === undefined) {
    const current = foldPlanDocuments(events).documents.get(id);
    return current === undefined ? undefined : toView(current);
  }
  for (const event of events) {
    const document = readPlanDocument(event);
    if (document?.id === id && document.version === version) return toView(document);
  }
  return undefined;
}

/**
 * The next plan id. Versions of an existing id stay on that id; this only
 * allocates ids for plans that do not exist yet.
 */
export function nextPlanDocumentId(events: readonly { type: string; data: unknown }[]): string {
  return `plan-${foldPlanDocuments(events).nextNumber}`;
}

/**
 * A new version must follow the latest one. The first version is 1.
 * Unknown plans cannot start above version 1, so a gap cannot be invented.
 */
export function assertNextPlanVersion(
  events: readonly { type: string; data: unknown }[],
  id: string,
  version: number,
): void {
  const current = foldPlanDocuments(events).documents.get(id);
  const expected = current === undefined ? 1 : current.version + 1;
  if (version !== expected) {
    throw new PlanDocumentError(
      `plan ${id} expected version ${expected}, got ${version}`,
      'PLAN_DOCUMENT_VERSION',
    );
  }
}

/** Body of one markdown heading section, without the heading line itself. */
export function planSection(body: string, heading: string): string | undefined {
  const wanted = normalizeHeading(heading);
  if (wanted === '') return undefined;
  const lines = body.split(/\r?\n/u);
  let start = -1;
  let startLevel = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseHeading(lines[index] ?? '');
    if (parsed === undefined) continue;
    if (start === -1) {
      if (parsed.text === wanted) {
        start = index;
        startLevel = parsed.level;
      }
      continue;
    }
    if (parsed.level <= startLevel) {
      return sectionText(lines, start, index);
    }
  }
  return start === -1 ? undefined : sectionText(lines, start, lines.length);
}

export class PlanDocumentError extends Error {
  constructor(message: string, readonly code: 'PLAN_DOCUMENT_VERSION' | 'PLAN_DOCUMENT_INVALID') {
    super(message);
    this.name = 'PlanDocumentError';
  }
}

function foldPlanDocuments(events: readonly { type: string; data: unknown }[]): PlanFold {
  const documents = new Map<string, PlanDocument>();
  let nextNumber = 1;
  for (const event of events) {
    const document = readPlanDocument(event);
    if (document === undefined) continue;
    const number = Number(document.id.slice('plan-'.length));
    if (number >= nextNumber) nextNumber = number + 1;
    const current = documents.get(document.id);
    if (current !== undefined && document.version !== current.version + 1) continue;
    if (current === undefined && document.version !== 1) continue;
    documents.set(document.id, document);
  }
  return { documents, nextNumber };
}

function readPlanDocument(event: { type: string; data: unknown }): PlanDocument | undefined {
  if (event.type !== PLAN_DOCUMENT_EVENT) return undefined;
  const parsed = PlanDocumentSchema.safeParse(event.data);
  return parsed.success ? parsed.data : undefined;
}

function toView(document: PlanDocument): PlanDocumentView {
  return {
    id: document.id,
    version: document.version,
    title: document.title,
    body: document.body,
    confirmedAt: document.confirmedAt,
  };
}

function parseHeading(line: string): { level: number; text: string } | undefined {
  const match = /^(#{1,6})[ \t]+(.+?)\s*$/u.exec(line);
  if (match === null) return undefined;
  const text = normalizeHeading(match[2] ?? '');
  if (text === '') return undefined;
  return { level: match[1]?.length ?? 0, text };
}

function normalizeHeading(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function sectionText(lines: readonly string[], start: number, end: number): string {
  return lines.slice(start + 1, end).join('\n').trim();
}
