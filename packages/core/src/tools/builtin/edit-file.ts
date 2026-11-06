import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import { displayPath, resolveInsidePhysical } from '../paths';
import { editTextFile } from '../fs-io';

/**
 * Model-facing literal edit, ported from `@deepseek-ai/dsh-tool-fs`'s edit tool
 * and DSH's `fs-local` edit implementation. Matching is literal and unique
 * unless `replace_all` is true; the file's line-ending style is preserved.
 */

const Params = z.object({
  file_path: z.string().describe('Path to edit, relative to the workspace or absolute inside it.'),
  old_string: z.string().describe('Literal text to replace.'),
  new_string: z.string().describe('Literal replacement text. Use an empty string to delete the match.'),
  replace_all: z.boolean().optional().describe('Replace every match. Defaults to false; false requires exactly one match.'),
});

export interface EditInput {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export function parseEditArgs(args: z.infer<typeof Params>): EditInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string');
  if (args.old_string.length === 0) throw new Error('old_string must be a non-empty string');
  if (args.old_string === args.new_string) throw new Error('old_string and new_string must differ');
  return {
    filePath: args.file_path,
    oldString: args.old_string,
    newString: args.new_string,
    replaceAll: args.replace_all ?? false,
  };
}

export function formatEditOutput(display: string, replaceAll: boolean): string {
  return replaceAll
    ? `The file ${display} has been updated. All occurrences were successfully replaced.`
    : `The file ${display} has been updated successfully.`;
}

export async function executeEditFile(
  cwd: string,
  input: EditInput,
  signal: AbortSignal,
): Promise<string> {
  const target = await resolveInsidePhysical(cwd, input.filePath);
  signal.throwIfAborted();
  await editTextFile(
    target,
    input.filePath,
    input.oldString,
    input.newString,
    input.replaceAll,
    signal,
  );
  return formatEditOutput(displayPath(cwd, target), input.replaceAll);
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description: 'Edit an existing UTF-8 text file by replacing literal text.',
  parameters: Params,
  mutating: true,
  async execute(args, ctx) {
    const input = parseEditArgs(Params.parse(args));
    return { content: await executeEditFile(ctx.cwd, input, ctx.signal) };
  },
};
