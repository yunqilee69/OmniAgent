import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import {
  GLOB_MAX_RESULTS,
  buildGlobCommand,
  formatGlobOutput,
  resolveSearchRoot,
  runRipgrep,
  toWorkdirRelative,
} from '../ripgrep';

/**
 * Model-facing file discovery, ported from `@deepseek-ai/dsh-tool-fs-search`.
 * It runs the packaged ripgrep binary directly (no shell), searches hidden and
 * ignored files, includes no directories, and orders results by modification
 * time.
 */

const Params = z.object({
  pattern: z.string().describe('Glob pattern matched against file paths, for example "**/*.ts" or "src/**/*.test.js".'),
  path: z.string().optional().describe('Directory to search. Defaults to the workspace root; relative paths resolve against it.'),
});

function parseGlobArgs(args: z.infer<typeof Params>): { pattern: string; path?: string } {
  if (args.pattern.trim().length === 0) throw new Error('pattern must be a non-empty string');
  if (args.path !== undefined && args.path.trim().length === 0) {
    throw new Error('path must be a non-empty string when given');
  }
  return { pattern: args.pattern, ...(args.path === undefined ? {} : { path: args.path }) };
}

export const globTool: Tool = {
  name: 'glob',
  description: 'Find files, not directories, whose paths match a glob pattern, including hidden and ignored files. '
    + `Returns up to ${GLOB_MAX_RESULTS} paths in modification-time order; a larger result is sampled across top-level entries.`,
  parameters: Params,
  mutating: false,
  async execute(args, ctx) {
    const input = parseGlobArgs(Params.parse(args));
    const search = await resolveSearchRoot(ctx.cwd, input.path, ctx.signal);
    const run = await runRipgrep(
      'glob',
      buildGlobCommand({ pattern: input.pattern, ...(search.target === undefined ? {} : { path: search.target }) }),
      ctx.cwd,
      ctx.signal,
    );
    if (run.noMatches) return { content: 'No files found' };

    const paths: string[] = [];
    for (const line of run.stdout.split('\n')) {
      if (line.length === 0) continue;
      paths.push(toWorkdirRelative(line, ctx.cwd));
    }
    return {
      content: formatGlobOutput(paths, search.root),
      ...(paths.length > GLOB_MAX_RESULTS ? { truncated: true } : {}),
    };
  },
};
