import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import { DEFAULT_READ_LINES } from '../limits';
import { displayPath, resolveInside } from '../paths';
import { truncateOutput } from '../tool';

const Params = z.object({
  path: z.string().describe('文件路径，相对工作区或绝对路径'),
  offset: z.number().int().nonnegative().optional().describe('起始行，0 起'),
  limit: z.number().int().positive().optional().describe('最多读取行数'),
});

export const readFileTool: Tool = {
  name: 'read_file',
  description: '读取文本文件，返回带行号的内容。默认最多 2000 行。',
  parameters: Params,
  mutating: false,
  async execute(args, ctx) {
    const { path, offset = 0, limit = DEFAULT_READ_LINES } = Params.parse(args);
    const absolute = resolveInside(ctx.cwd, path);
    ctx.signal.throwIfAborted();

    const raw = await readFile(absolute, 'utf8');
    const lines = raw.split('\n');
    const slice = lines.slice(offset, offset + limit);
    const body = slice
      .map((line, index) => `${String(offset + index + 1).padStart(5)}\t${line}`)
      .join('\n');

    const header = `# ${displayPath(ctx.cwd, absolute)}（共 ${lines.length} 行）\n`;
    return truncateOutput(header + body);
  },
};
