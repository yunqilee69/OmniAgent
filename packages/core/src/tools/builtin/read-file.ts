import { open, readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import { DEFAULT_READ_LINES, MAX_READ_BYTES } from '../limits';
import { displayPath, resolveInside, resolveInsidePhysical } from '../paths';
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
    const visible = resolveInside(ctx.cwd, path);
    const absolute = await resolveInsidePhysical(ctx.cwd, path);
    ctx.signal.throwIfAborted();

    const file = await open(absolute, 'r');
    let size: number;
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error(`不是普通文件：${path}`);
      size = info.size;
    } finally {
      await file.close();
    }
    if (size > MAX_READ_BYTES) {
      throw new Error(`文件过大（${size} 字节，上限 ${MAX_READ_BYTES}）；请改用 offset/limit 或 shell 分段读取。`);
    }
    const raw = await readFile(absolute, 'utf8');
    ctx.signal.throwIfAborted();
    const lines = raw.split('\n');
    const slice = lines.slice(offset, offset + limit);
    const body = slice
      .map((line, index) => `${String(offset + index + 1).padStart(5)}\t${line}`)
      .join('\n');

    const header = `# ${displayPath(ctx.cwd, visible)}（共 ${lines.length} 行）\n`;
    return truncateOutput(header + body);
  },
};
