import type { Dirent } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import { MAX_DIRECTORY_ENTRIES } from '../limits';
import { displayPath, resolveInside, resolveInsidePhysical } from '../paths';
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
    const visible = resolveInside(ctx.cwd, path);
    const absolute = await resolveInsidePhysical(ctx.cwd, path);
    ctx.signal.throwIfAborted();

    const entries = await opendir(absolute);
    const visibleEntries: Dirent[] = [];
    let omitted = 0;
    try {
      for await (const entry of entries) {
        ctx.signal.throwIfAborted();
        if (IGNORED.has(entry.name)) continue;
        if (visibleEntries.length >= MAX_DIRECTORY_ENTRIES) { omitted += 1; continue; }
        visibleEntries.push(entry);
      }
    } finally {
      await entries.close().catch(() => undefined);
    }
    const lines = visibleEntries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    if (omitted > 0) lines.push(`… （另有 ${omitted} 个条目未列出，上限 ${MAX_DIRECTORY_ENTRIES}）`);

    return truncateOutput(`${displayPath(ctx.cwd, visible)}/\n${lines.join('\n')}`);
  },
};
