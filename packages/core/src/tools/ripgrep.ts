import { spawn } from 'node:child_process';
import { isAbsolute, relative, sep } from 'node:path';
import { resolveInside, resolveInsidePhysical } from './paths';

/**
 * Shared execution plumbing for the DSH-ported `glob`/`grep` tools.
 *
 * The packaged `@vscode/ripgrep` binary is spawned with a fixed argv vector —
 * never through a shell. Raw stdout is parsed only after a complete, bounded
 * capture. The model-facing caps and formatting mirror DSH's
 * `tool-fs-search` package.
 */

export type SearchErrorCode =
  | 'SEARCH_INVALID_PATTERN'
  | 'SEARCH_FAILED'
  | 'SEARCH_RAW_OUTPUT_OVERFLOW'
  | 'SEARCH_ABORTED';

export class SearchError extends Error {
  readonly code: SearchErrorCode;

  constructor(message: string, code: SearchErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SearchError';
    this.code = code;
  }
}

/** Complete raw ripgrep stdout cap. Larger output fails instead of being parsed partially. */
export const RAW_OUTPUT_MAX_BYTES = 20_000_000;

/** Cooperative search timeout. */
export const SEARCH_TIMEOUT_MS = 30_000;

/** Grace period between SIGTERM and SIGKILL. */
const SEARCH_GRACE_MS = 3_000;

/** Retained stderr diagnostic tail. */
const SEARCH_STDERR_MAX_BYTES = 64 * 1024;

/** DSH's default inline glob result cap. */
export const GLOB_MAX_RESULTS = 100;

/** VCS metadata never appears in discovery results. */
export const GLOB_VCS_EXCLUDES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];

/** DSH's default inline grep match cap. */
export const GREP_MAX_MATCHES = 250;

/** DSH's default per-line preview cap. */
export const GREP_MAX_LINE_BYTES = 2_000;

/** One parsed grep match. */
export interface GrepMatch {
  path: string;
  lineNumber: number;
  line: string;
}

interface RipgrepRun {
  stdout: string;
  noMatches: boolean;
}

let rgPathPromise: Promise<string> | undefined;

function resolveRgPath(): Promise<string> {
  rgPathPromise ??= import('@vscode/ripgrep')
    .then((module) => module.rgPath)
    .catch((error: unknown) => {
      throw new SearchError(
        'packaged ripgrep is unavailable; reinstall @vscode/ripgrep for this platform',
        'SEARCH_FAILED',
        { cause: error },
      );
    });
  return rgPathPromise;
}

function searchEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
    'SystemRoot', 'ComSpec', 'PATHEXT',
  ] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.NO_COLOR = '1';
  return env;
}

function terminate(child: ReturnType<typeof spawn>): NodeJS.Timeout {
  if (child.pid !== undefined) {
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  const escalation = setTimeout(() => {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The process already exited.
    }
  }, SEARCH_GRACE_MS);
  escalation.unref();
  return escalation;
}

function stderrExcerpt(stderr: string): string {
  const text = stderr.trim();
  return text.length === 0 ? '' : text;
}

function classifyFailure(toolName: string, exitCode: number | null, stderr: string): SearchError {
  const detail = stderrExcerpt(stderr);
  if (/regex parse error|error parsing glob/i.test(detail)) {
    return new SearchError(`${toolName} pattern rejected by ripgrep: ${detail}`, 'SEARCH_INVALID_PATTERN');
  }
  return new SearchError(
    `${toolName} search failed (exit ${exitCode ?? 'signal'})${detail.length > 0 ? `: ${detail}` : ''}`,
    'SEARCH_FAILED',
  );
}

/**
 * Run the packaged ripgrep with DSH's transport limits. Every model-controlled
 * value is a plain argv element; the caller has already fenced the search root.
 */
export async function runRipgrep(
  toolName: 'glob' | 'grep',
  argv: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<RipgrepRun> {
  if (signal.aborted) {
    throw new SearchError(`${toolName} was aborted before completion`, 'SEARCH_ABORTED');
  }
  const binary = await resolveRgPath();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  let aborted = false;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const stop = (): void => {
    killTimer ??= terminate(child);
  };

  const child = spawn(binary, ['--no-config', ...argv], {
    cwd,
    env: searchEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  const onAbort = (): void => {
    aborted = true;
    stop();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, SEARCH_TIMEOUT_MS);
  deadline.unref();

  child.stdout.on('data', (chunk: Buffer) => {
    if (stdoutBytes >= RAW_OUTPUT_MAX_BYTES) {
      overflow = true;
      stop();
      return;
    }
    const remaining = RAW_OUTPUT_MAX_BYTES - stdoutBytes;
    if (chunk.length > remaining) {
      stdout.push(chunk.subarray(0, remaining));
      stdoutBytes += remaining;
      overflow = true;
      stop();
      return;
    }
    stdout.push(chunk);
    stdoutBytes += chunk.length;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes >= SEARCH_STDERR_MAX_BYTES) return;
    const remaining = SEARCH_STDERR_MAX_BYTES - stderrBytes;
    const kept = chunk.subarray(0, remaining);
    stderr.push(kept);
    stderrBytes += kept.length;
  });

  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  try {
    [exitCode, exitSignal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, termSignal) => resolve([code, termSignal]));
    });
  } catch (error: unknown) {
    throw new SearchError(`${toolName} could not start its search command (ripgrep launch failed)`, 'SEARCH_FAILED', { cause: error });
  } finally {
    clearTimeout(deadline);
    if (killTimer) clearTimeout(killTimer);
    signal.removeEventListener('abort', onAbort);
  }

  if (aborted) throw new SearchError(`${toolName} was aborted before completion`, 'SEARCH_ABORTED');
  if (timedOut) throw new SearchError(`${toolName} timed out after ${SEARCH_TIMEOUT_MS}ms`, 'SEARCH_ABORTED');
  if (overflow) {
    throw new SearchError(
      `${toolName} produced more than the ${RAW_OUTPUT_MAX_BYTES}-byte raw output cap; narrow pattern, path, or include and retry`,
      'SEARCH_RAW_OUTPUT_OVERFLOW',
    );
  }
  if (exitSignal !== null || exitCode === null) {
    throw new SearchError(`${toolName} search command was killed by signal ${exitSignal ?? '(unknown)'}`, 'SEARCH_FAILED');
  }
  if (exitCode !== 0 && exitCode !== 1) {
    throw classifyFailure(toolName, exitCode, Buffer.concat(stderr).toString('utf8'));
  }
  return {
    stdout: Buffer.concat(stdout).toString('utf8'),
    noMatches: exitCode === 1,
  };
}

/** Map an absolute ripgrep output path under the workspace to a relative display path. */
export function toWorkdirRelative(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  if (rel.length === 0) return '.';
  if (rel === '..' || rel.startsWith(`..${sep}`)) return path;
  return rel;
}

/**
 * Fence a model-supplied search root to the workspace before ripgrep runs.
 * Returns the argv target (relative to `cwd`) and its display root.
 */
export async function resolveSearchRoot(
  cwd: string,
  path: string | undefined,
  signal: AbortSignal,
): Promise<{ target: string | undefined; root: string }> {
  if (path === undefined) return { target: undefined, root: '.' };
  const visible = resolveInside(cwd, path);
  await resolveInsidePhysical(cwd, path);
  signal.throwIfAborted();
  const rel = relative(cwd, visible);
  if (rel === '' || rel === '.') return { target: undefined, root: '.' };
  return { target: rel, root: rel };
}

/** Bound one matched-line preview to bytes without splitting a UTF-8 sequence. */
export function previewLine(line: string, maxBytes: number): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= maxBytes) return line;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')} (line truncated)`;
}

/** Apply the inline cap and per-line preview to every parsed match. */
export function retainGrepMatches(
  matches: readonly GrepMatch[],
  maxMatches: number,
  maxLineBytes: number,
): { items: GrepMatch[]; seen: number; truncated: boolean } {
  const items = matches.slice(0, maxMatches).map((match) => ({
    ...match,
    line: previewLine(match.line, maxLineBytes),
  }));
  return { items, seen: matches.length, truncated: matches.length > maxMatches };
}

/** Group flat matches by file and render DSH's model-facing body. */
export function formatGrepMatches(matches: readonly GrepMatch[]): string {
  const byFile = new Map<string, GrepMatch[]>();
  for (const match of matches) {
    const group = byFile.get(match.path);
    if (group === undefined) byFile.set(match.path, [match]);
    else group.push(match);
  }
  return [...byFile].map(([path, group]) => (
    `${path}\n${group.map((match) => `Line ${match.lineNumber}: ${match.line}`).join('\n')}`
  )).join('\n\n');
}

export function formatGrepOutput(
  retained: { items: GrepMatch[]; seen: number; truncated: boolean },
): string {
  if (retained.seen === 0) return 'No matches found';
  const header = retained.truncated
    ? `Found ${retained.items.length} of ${retained.seen} matches`
    : `Found ${retained.seen} ${retained.seen === 1 ? 'match' : 'matches'}`;
  const body = formatGrepMatches(retained.items);
  return retained.truncated
    ? `${header}\n\n${body}\n\n(The complete result could not be saved; narrow pattern, path, or include to see more.)`
    : `${header}\n\n${body}`;
}

/**
 * Build DSH's fixed `rg --files` argv. Directory prefixes prune unrelated
 * subtrees; hidden and ignored files are searched, with VCS metadata excluded.
 */
export function buildGlobCommand(input: { pattern: string; path?: string }): string[] {
  const directories = input.pattern.split('/').slice(0, -1);
  const pruning: string[] = [];
  if (input.path === undefined && directories.length > 0
    && directories.every((part) => /^[\w .-]+$/.test(part)
      && part !== '.' && part !== '..' && !GLOB_VCS_EXCLUDES.includes(part))) {
    const directoryGlob = `--glob={${[...new Set(directories)].join(',')}}/`;
    if (directoryGlob.length + '--glob=!**'.length + 2 <= 8 * 1024) {
      pruning.push('--glob=!**', directoryGlob);
    }
  }
  const parts = [
    '--files',
    ...pruning,
    `--glob=${input.pattern}`,
    '--sort=modified',
    '--no-ignore',
    '--hidden',
    ...GLOB_VCS_EXCLUDES.flatMap((name) => [
      `--glob=!**/${name}`,
      `--glob=!**/${name}/**`,
    ]),
  ];
  if (input.path !== undefined) parts.push('--', input.path);
  return parts;
}

/** Build DSH's fixed line-oriented `rg --json` argv. */
export function buildGrepCommand(input: { pattern: string; path?: string; include?: string }): string[] {
  const parts = ['--json', `--regexp=${input.pattern}`];
  if (input.include !== undefined) parts.push(`--glob=${input.include}`);
  if (input.path !== undefined) parts.push('--', input.path);
  return parts;
}

/** Parse one `rg --json` record; non-match records are transport framing. */
function parseRecord(line: string): GrepMatch | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error: unknown) {
    throw new SearchError('grep received malformed ripgrep --json output (a line is not JSON)', 'SEARCH_FAILED', { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SearchError('grep received malformed ripgrep --json output (a record is not an object)', 'SEARCH_FAILED');
  }
  const record = parsed as { type?: unknown; data?: unknown };
  if (record.type !== 'match') return undefined;
  if (typeof record.data !== 'object' || record.data === null) {
    throw new SearchError('grep received malformed ripgrep --json output (a match record has no data)', 'SEARCH_FAILED');
  }
  const data = record.data as { path?: unknown; line_number?: unknown; lines?: unknown };
  const pathText = typeof data.path === 'object' && data.path !== null
    ? (data.path as { text?: unknown }).text
    : undefined;
  if (typeof pathText !== 'string') {
    throw new SearchError('grep received malformed ripgrep --json output (a match record has no path text)', 'SEARCH_FAILED');
  }
  if (typeof data.line_number !== 'number') {
    throw new SearchError('grep received malformed ripgrep --json output (a match record has no line number)', 'SEARCH_FAILED');
  }
  if (typeof data.lines !== 'object' || data.lines === null) {
    throw new SearchError('grep received malformed ripgrep --json output (a match record has no line content)', 'SEARCH_FAILED');
  }
  const lines = data.lines as { text?: unknown; bytes?: unknown };
  if (typeof lines.text === 'string') {
    return { path: pathText, lineNumber: data.line_number, line: lines.text.replace(/\r?\n$/, '') };
  }
  if (typeof lines.bytes === 'string') {
    return { path: pathText, lineNumber: data.line_number, line: '(line is not valid UTF-8)' };
  }
  throw new SearchError('grep received malformed ripgrep --json output (a match record has neither line text nor bytes)', 'SEARCH_FAILED');
}

export function parseGrepMatches(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const match = parseRecord(line);
    if (match !== undefined) matches.push(match);
  }
  return matches;
}

/** Remove a displayed search-root prefix before choosing a top-level group. */
function relativeToSearchRoot(path: string, root: string): string {
  if (root === '.') return path.startsWith(`.${sep}`) ? path.slice(2) : path;
  let end = root.length;
  while (end > 0 && root[end - 1] === sep) end -= 1;
  const trimmed = root.slice(0, end);
  if (trimmed.length === 0) return stripLeadingSeparators(path);
  if (path === trimmed) return '';
  if (path.startsWith(`${trimmed}${sep}`)) return path.slice(trimmed.length + 1);
  return path;
}

function stripLeadingSeparators(path: string): string {
  let start = 0;
  while (path[start] === sep) start += 1;
  return path.slice(start);
}

function topLevelSegment(path: string): string {
  const trimmed = stripLeadingSeparators(path);
  const cut = trimmed.indexOf(sep);
  return cut === -1 ? trimmed : trimmed.slice(0, cut);
}

/** Round-robin the inline page across top-level entries, matching DSH's glob sampler. */
export function sampleAcrossTopLevel(
  paths: readonly string[],
  maxItems: number,
  root = '.',
): { items: string[]; shown: number; total: number } {
  const groups = new Map<string, string[]>();
  let active: { key: string; items: string[]; index: number; current: string }[] = [];
  for (const path of paths) {
    const key = topLevelSegment(relativeToSearchRoot(path, root));
    const group = groups.get(key);
    if (group === undefined) {
      const items = [path];
      groups.set(key, items);
      active.push({ key, items, index: 0, current: path });
    } else {
      group.push(path);
    }
  }
  const taken = new Map<string, string[]>();
  let count = 0;
  while (active.length > 0 && count < maxItems) {
    const next: typeof active = [];
    for (const group of active) {
      if (count >= maxItems) break;
      count += 1;
      const bucket = taken.get(group.key);
      if (bucket === undefined) taken.set(group.key, [group.current]);
      else bucket.push(group.current);
      const nextIndex = group.index + 1;
      const nextPath = group.items[nextIndex];
      if (nextPath !== undefined) next.push({ ...group, index: nextIndex, current: nextPath });
    }
    active = next;
  }
  return { items: [...taken.values()].flat(), shown: taken.size, total: groups.size };
}

/** Render the glob page exactly as DSH does, minus a spill backend. */
export function formatGlobOutput(paths: readonly string[], root: string): string {
  if (paths.length === 0) return 'No files found';
  if (paths.length <= GLOB_MAX_RESULTS) return paths.join('\n');
  const sample = sampleAcrossTopLevel(paths, GLOB_MAX_RESULTS, root);
  const basis = sample.total === paths.length
    ? '.'
    : `, sampled across ${sample.shown} of the ${sample.total} top-level entries this pattern matched instead of taken in modification-time order.`
      + (sample.shown < sample.total ? ' Narrow path to inspect a specific subtree.' : '');
  return `${sample.items.join('\n')}\n\n(Showing ${sample.items.length} of ${paths.length} paths${basis} `
    + 'The complete result could not be saved; narrow pattern or path to see more.)';
}
