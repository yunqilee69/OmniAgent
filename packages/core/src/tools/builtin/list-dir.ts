import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import { displayPath, resolveInside } from '../paths';
import { truncateOutput } from '../tool';

const Params = z.object({
  path: z.string().default('.').describe('目录路径，默认工作区根目录'),
});

const IGNORED = new Set(['node_modules', '.git', 'dist', '.omniagent']);

export const listDirTool: Tool = {
  name: 'list_dir',
  description: '列出目录下的条目，目录名带 / 后缀。默认忽略 node_modules、.git 等。',
  parameters: Params,
  mutating: false,
  async execute(args, ctx) {
    const { path } = Params.parse(args);
    const absolute = resolveInside(ctx.cwd, path);
    ctx.signal.throwIfAborted();

    const entries = await readdir(absolute, { withFileTypes: true });
    const lines = entries
      .filter((entry) => !IGNORED.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));

    return truncateOutput(`${displayPath(ctx.cwd, absolute)}/\n${lines.join('\n')}`);
  },
};
