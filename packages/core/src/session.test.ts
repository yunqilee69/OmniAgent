import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './protocol/events';
import type { PermissionRequest } from './protocol/permission';
import { FakeModel, textResponse, toolCallResponse } from './providers/fake';
import { Session } from './session';
import { ToolRegistry } from './tools/registry';
import { z } from 'zod';
import type { Tool } from './domain/tool';

/**
 * 组合根冒烟测试：验证「模型 + 工具 + 权限门 + 审计」真的接上了。
 * 这里故意用真实的内置工具（list_dir），走一遍真实的文件系统。
 */

const noopTool: Tool = {
  name: 'noop',
  description: '什么都不做',
  parameters: z.object({}),
  mutating: false,
  async execute() {
    return { content: 'ok' };
  },
};

async function collect(generator: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

describe('Session', () => {
  it('省略 mode 时默认允许工作区读写，未知工具仍询问', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omni-session-'));
    const approve = vi.fn(async (_request: PermissionRequest) => 'deny' as const);
    const model = new FakeModel([
      toolCallResponse([{ name: 'write_file', args: { path: 'hello.txt', content: 'hello' } }]),
      toolCallResponse([{ name: 'read_file', args: { path: 'hello.txt' } }]),
      toolCallResponse([{ name: 'list_dir', args: { path: '.' } }]),
      toolCallResponse([{ name: 'unknown_tool', args: {} }]),
      textResponse('完成'),
    ]);
    try {
      const session = new Session({ cwd, model, approve });
      const events = await collect(session.send('开始'));
      expect(await readFile(join(cwd, 'hello.txt'), 'utf8')).toBe('hello');
      expect(events.filter((event) => event.type === 'tool.result')).toHaveLength(4);
      expect(events.filter((event) => event.type === 'permission.decided').map(
        (event) => event.decision,
      )).toEqual(['allow', 'allow', 'allow', 'deny']);
      expect(approve).toHaveBeenCalledTimes(1);
      expect(approve.mock.calls[0]?.[0]).toMatchObject({ call: { name: 'unknown_tool' } });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('把权限确认交给 UI 回调，而不是自己弹窗', async () => {
    const asked: PermissionRequest[] = [];
    const model = new FakeModel([
      toolCallResponse([{ id: 'c1', name: 'noop', args: {} }]),
      textResponse('好了'),
    ]);

    const registry = new ToolRegistry().register(noopTool);
    const session = new Session({
      cwd: process.cwd(),
      model,
      tools: registry,
      mode: 'default',
      approve: async (request) => {
        asked.push(request);
        return 'allow';
      },
    });

    const events = await collect(session.send('开始'));

    expect(asked).toHaveLength(1);
    expect(asked[0]?.call.name).toBe('noop');
    expect(events.some((event) => event.type === 'permission.decided')).toBe(true);
    expect(session.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('被拒绝的调用不会执行，但会话可以继续', async () => {
    const model = new FakeModel([
      toolCallResponse([{ id: 'c1', name: 'noop', args: {} }]),
      textResponse('那我换个办法'),
    ]);
    const registry = new ToolRegistry().register(noopTool);

    const session = new Session({
      cwd: process.cwd(),
      model,
      tools: registry,
      mode: 'default',
      approve: async () => 'deny',
    });

    const events = await collect(session.send('开始'));
    const result = events.find((event) => event.type === 'tool.result');

    expect(result).toMatchObject({ result: { ok: false } });
    expect(events.at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
  });
});
