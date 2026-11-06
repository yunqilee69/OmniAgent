import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import { displayPath, resolveInsidePhysical } from '../paths';
import { writeTextFile } from '../fs-io';

/**
 * Model-facing full-file write, ported from `@deepseek-ai/dsh-tool-fs`'s write
 * tool and DSH's atomic `fs-local` publication. The sandboxed session replaces
 * this tool with a policy-aware wrapper; this instance is only used when the
 * fully trusted preset is active.
 */

const Params = z.object({
  file_path: z.string().describe('Path to write, relative to the workspace or absolute inside it.'),
  content: z.string().describe('Full UTF-8 text content to write.'),
});

export function parseWriteArgs(args: z.infer<typeof Params>): { filePath: string; content: string } {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string');
  return { filePath: args.file_path, content: args.content };
}

export function formatWriteOutput(display: string, operation: 'create' | 'update'): string {
  const verb = operation === 'create' ? 'Created' : 'Updated';
  return `<path>${display}</path>\n<type>file</type>\n<content>\n${verb} file\n</content>`;
}

export async function executeWriteFile(
  cwd: string,
  filePath: string,
  content: string,
  signal: AbortSignal,
): Promise<string> {
  const target = await resolveInsidePhysical(cwd, filePath);
  signal.throwIfAborted();
  const outcome = await writeTextFile(target, filePath, content, signal);
  return formatWriteOutput(displayPath(cwd, target), outcome.operation);
}

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Create or fully replace a UTF-8 text file.',
  parameters: Params,
  mutating: true,
  async execute(args, ctx) {
    const input = parseWriteArgs(Params.parse(args));
    return { content: await executeWriteFile(ctx.cwd, input.filePath, input.content, ctx.signal) };
  },
};
