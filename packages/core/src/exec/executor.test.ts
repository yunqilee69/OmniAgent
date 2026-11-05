import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Tool } from '../domain/tool';
import { ToolExecutor } from './executor';
import { ToolRegistry } from '../tools/registry';

function executorFor(output: { content: string; ok?: boolean }) {
  const tool: Tool = {
    name: 'bash', description: 'Run a command', parameters: z.object({ command: z.string() }), mutating: true,
    async execute() { return output; },
  };
  return new ToolExecutor(new ToolRegistry().register(tool), { cwd: '/workspace', signal: new AbortController().signal });
}

describe('ToolExecutor', () => {
  it('preserves an explicit tool failure result', async () => {
    const result = await executorFor({ content: 'exit code: 42', ok: false }).execute({
      id: 'call-1', name: 'bash', arguments: { command: 'exit 42' },
    });
    expect(result).toMatchObject({ ok: false, content: 'exit code: 42' });
  });

  it('defaults tools without an explicit status to success', async () => {
    const result = await executorFor({ content: 'done' }).execute({
      id: 'call-1', name: 'bash', arguments: { command: 'true' },
    });
    expect(result).toMatchObject({ ok: true, content: 'done' });
  });
});
