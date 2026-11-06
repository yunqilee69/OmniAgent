import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import {
  GREP_MAX_LINE_BYTES,
  GREP_MAX_MATCHES,
  buildGrepCommand,
  formatGrepOutput,
  parseGrepMatches,
  resolveSearchRoot,
  retainGrepMatches,
  runRipgrep,
  toWorkdirRelative,
} from '../ripgrep';

/**
 * Model-facing content search, ported from `@deepseek-ai/dsh-tool-fs-search`.
 * It runs the packaged ripgrep binary directly with `--json`, so file paths,
 * line numbers, and line text do not require colon-splitting.
 */

const Params = z.object({
  pattern: z.string().describe('Ripgrep regular expression to search for.'),
  path: z.string().optional().describe('File or directory to search. Defaults to the workspace root.'),
  include: z.string().optional().describe('One positive glob filter for which files to search, for example "*.ts" or "*.{js,jsx}".'),
});

interface GrepInput {
  pattern: string;
  path?: string;
  include?: string;
}

function validateInclude(include: string): void {
  if (include.trim().length === 0) throw new Error('include must be a non-empty glob when given');
  if (include.startsWith('!')) {
    throw new Error('include must be a positive glob filter; negated patterns ("!…") are not supported');
  }
  let braceDepth = 0;
  for (const char of include) {
    if (char === '{') braceDepth += 1;
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (char === ',' && braceDepth === 0) {
      throw new Error('include must be one glob, not a comma-separated list (use {a,b} alternation instead)');
    }
  }
}

function parseGrepArgs(args: z.infer<typeof Params>): GrepInput {
  if (args.pattern.length === 0) throw new Error('pattern must be a non-empty string');
  if (args.path !== undefined && args.path.trim().length === 0) {
    throw new Error('path must be a non-empty string when given');
  }
  const include = args.include === '' ? undefined : args.include;
  if (include !== undefined) validateInclude(include);
  return {
    pattern: args.pattern,
    ...(args.path === undefined ? {} : { path: args.path }),
    ...(include === undefined ? {} : { include }),
  };
}

export const grepTool: Tool = {
  name: 'grep',
  description: 'Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. '
    + `Returns up to ${GREP_MAX_MATCHES} matches; a larger result reports that it was capped.`,
  parameters: Params,
  mutating: false,
  async execute(args, ctx) {
    const input = parseGrepArgs(Params.parse(args));
    const search = await resolveSearchRoot(ctx.cwd, input.path, ctx.signal);
    const run = await runRipgrep(
      'grep',
      buildGrepCommand({
        pattern: input.pattern,
        ...(search.target === undefined ? {} : { path: search.target }),
        ...(input.include === undefined ? {} : { include: input.include }),
      }),
      ctx.cwd,
      ctx.signal,
    );
    if (run.noMatches) return { content: 'No matches found' };

    const matches = parseGrepMatches(run.stdout).map((match) => ({
      ...match,
      path: toWorkdirRelative(match.path, ctx.cwd),
    }));
    const retained = retainGrepMatches(matches, GREP_MAX_MATCHES, GREP_MAX_LINE_BYTES);
    return {
      content: formatGrepOutput(retained),
      ...(retained.truncated ? { truncated: true } : {}),
    };
  },
};
