import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import { displayPath, resolveInside } from '../paths';

const Params = z.object({
  path: z.string().describe('要写入的文件路径'),
  content: z.string().describe('完整文件内容，会覆盖原文件'),
});

export const writeFileTool: Tool = {
  name: 'write_file',
  description: '写入（覆盖）工作区内一个文本文件，父目录不存在会自动创建。',
  parameters: Params,
  mutating: true,
  async execute(args, ctx) {
    const { path, content } = Params.parse(args);
    const absolute = resolveInside(ctx.cwd, path);
    ctx.signal.throwIfAborted();

    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');

    const lineCount = content.split('\n').length;
    return {
      content: `已写入 ${displayPath(ctx.cwd, absolute)}（${content.length} 字符，${lineCount} 行）`,
    };
  },
};
