import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import { displayPath, resolveInsidePhysical } from '../paths';
import { readWholeText, statRegularFile, streamWholeText } from '../fs-io';

/**
 * Model-facing UTF-8 read, ported from `@deepseek-ai/dsh-tool-fs` and
 * `dsh-fs-local`. The file is statted once for type/size routing, streamed when
 * large, and rendered as a bounded line window with an exact total line count.
 */

/** Default and maximum number of lines returned by one read call. */
export const READ_LIMIT = 2_000;

/** Maximum characters returned for a single line. */
export const READ_MAX_LINE_LENGTH = 2_000;

/** Maximum bytes returned for the selected lines. */
export const READ_MAX_BYTES = 50 * 1024;

/** Files at or above this size stream instead of being read whole. */
export const STREAM_MIN_SIZE = 10 * 1024 * 1024;

const Params = z.object({
  file_path: z.string().describe('Path to read, relative to the workspace or absolute inside it.'),
  offset: z.number().optional().describe('1-based first line to return. Defaults to 1.'),
  limit: z.number().optional().describe(`Maximum number of lines to return. Defaults to ${READ_LIMIT}.`),
});

interface ReadInput {
  filePath: string;
  offset: number;
  limit: number;
}

interface FileTextLine {
  number: number;
  text: string;
}

interface WindowResult {
  lines: FileTextLine[];
  totalLines: number;
  truncatedByBytes: boolean;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseReadArgs(args: z.infer<typeof Params>): ReadInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string');
  const offset = args.offset === undefined ? 1 : positiveInteger(args.offset, 'offset');
  const limit = args.limit === undefined ? READ_LIMIT : positiveInteger(args.limit, 'limit');
  if (limit > READ_LIMIT) throw new Error(`limit must be less than or equal to ${READ_LIMIT}`);
  return { filePath: args.file_path, offset, limit };
}

/**
 * Build one window while still scanning the whole stream for an exact total
 * line count. Per-line and total byte caps match DSH's read renderer.
 */
async function buildWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  request: { offset: number; limit: number; maxLineLength: number; maxBytes: number },
  display: string,
): Promise<WindowResult> {
  const lines: FileTextLine[] = [];
  let totalLines = 0;
  let outputBytes = 0;
  let truncatedByBytes = false;
  const lineBufferCap = request.maxLineLength + 1;
  let lineBuffer = '';

  const consume = (rawLine: string): void => {
    totalLines += 1;
    if (truncatedByBytes || totalLines < request.offset || lines.length >= request.limit) return;
    const line = rawLine.length > request.maxLineLength
      ? `${rawLine.substring(0, request.maxLineLength)}... (line truncated to ${request.maxLineLength} chars)`
      : rawLine;
    const bytes = Buffer.byteLength(line, 'utf8') + (lines.length > 0 ? 1 : 0);
    if (outputBytes + bytes > request.maxBytes) {
      truncatedByBytes = true;
      return;
    }
    outputBytes += bytes;
    lines.push({ number: totalLines, text: line });
  };

  const flush = (): void => {
    consume(lineBuffer.endsWith('\r') ? lineBuffer.slice(0, -1) : lineBuffer);
    lineBuffer = '';
  };

  const append = (segment: string): void => {
    if (lineBuffer.length >= lineBufferCap) return;
    lineBuffer += segment;
    if (lineBuffer.length > lineBufferCap) lineBuffer = lineBuffer.slice(0, lineBufferCap);
  };

  for await (const chunk of chunks) {
    let start = 0;
    let newline: number;
    while ((newline = chunk.indexOf('\n', start)) !== -1) {
      append(chunk.slice(start, newline));
      flush();
      start = newline + 1;
    }
    append(chunk.slice(start));
  }
  if (lineBuffer.length > 0) flush();

  if (!truncatedByBytes && request.offset > totalLines && !(totalLines === 0 && request.offset === 1)) {
    throw new Error(`offset ${request.offset} is out of range for "${display}" (${totalLines} lines)`);
  }
  return { lines, totalLines, truncatedByBytes };
}

function formatReadOutput(display: string, offset: number, window: WindowResult): string {
  const endLine = window.lines.at(-1)?.number ?? Math.max(0, offset - 1);
  let footer: string;
  if (window.truncatedByBytes) {
    footer = `(Output capped. Showing lines ${offset}-${endLine}. Use offset=${endLine + 1} to continue.)`;
  } else if (endLine < window.totalLines) {
    footer = `(Showing lines ${offset}-${endLine} of ${window.totalLines}. Use offset=${endLine + 1} to continue.)`;
  } else {
    footer = `(End of file - total ${window.totalLines} lines)`;
  }
  const body = window.lines.length > 0
    ? `${window.lines.map((line) => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
    : footer;
  return `<path>${display}</path>\n<type>file</type>\n<content>\n${body}\n</content>`;
}

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a UTF-8 text file and return line-numbered content.',
  parameters: Params,
  mutating: false,
  async execute(args, ctx) {
    const input = parseReadArgs(Params.parse(args));
    const target = await resolveInsidePhysical(ctx.cwd, input.filePath);
    const info = await statRegularFile(target, input.filePath, 'read');
    ctx.signal.throwIfAborted();

    const chunks = info.size >= STREAM_MIN_SIZE
      ? streamWholeText(target, input.filePath, ctx.signal)
      : [await readWholeText(target, input.filePath, ctx.signal)];
    const window = await buildWindow(chunks, {
      offset: input.offset,
      limit: input.limit,
      maxLineLength: READ_MAX_LINE_LENGTH,
      maxBytes: READ_MAX_BYTES,
    }, input.filePath);

    const content = formatReadOutput(displayPath(ctx.cwd, target), input.offset, window);
    const endLine = window.lines.at(-1)?.number ?? Math.max(0, input.offset - 1);
    return {
      content,
      ...(window.truncatedByBytes || endLine < window.totalLines ? { truncated: true } : {}),
    };
  },
};
