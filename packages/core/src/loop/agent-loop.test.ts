import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Message } from '../domain/message';
import { userMessage } from '../domain/message';
import type { Tool } from '../domain/tool';
import type { AgentEvent } from '../protocol/events';
import type { PermissionGate } from '../protocol/permission';
import { FakeModel, textResponse, toolCallResponse } from '../providers/fake';
import { ToolRegistry } from '../tools/registry';
import { AgentLoop } from './agent-loop';

/**
 * 主循环的测试全部跑在假模型上：零 token、毫秒级、可以断言精确的事件顺序。
 * 真模型只该用来评估「提示词好不好」，不该用来验证「循环对不对」。
 */

const echoTool: Tool = {
  name: 'echo',
  description: '原样返回输入文本',
  parameters: z.object({ text: z.string() }),
  mutating: false,
  async execute(args) {
    const { text } = z.object({ text: z.string() }).parse(args);
    return { content: `echo:${text}` };
  },
};

const allowAll: PermissionGate = {
  async check() {
    return { decision: 'allow', source: 'test:allow-all' };
  },
};

function registryWithEcho(): ToolRegistry {
  return new ToolRegistry().register(echoTool);
}

async function collect(generator: AsyncGenerator<AgentEvent, Message[]>) {
  const events: AgentEvent[] = [];
  let next = await generator.next();
  while (!next.done) {
    events.push(next.value);
    next = await generator.next();
  }
  return { events, messages: next.value };
}

describe('AgentLoop', () => {
  it('把工具结果回灌给模型，然后结束', async () => {
    const model = new FakeModel([
      toolCallResponse([{ id: 'c1', name: 'echo', args: { text: 'hi' } }]),
      textResponse('完成'),
    ]);

    const loop = new AgentLoop({
      model,
      modelId: 'fake',
      system: 'test',
      tools: registryWithEcho(),
      permissions: allowAll,
      cwd: process.cwd(),
      sessionId: 'test',
    });

    const { events, messages } = await collect(loop.run([userMessage('开始')]));

    expect(events.map((event) => event.type)).toEqual([
      'turn.start',
      'assistant.message',
      'tool.call',
      'permission.decided',
      'tool.result',
      'turn.start',
      'assistant.delta',
      'assistant.message',
      'turn.end',
    ]);

    const delta = events.find((event) => event.type === 'assistant.delta');
    expect(delta).toEqual({ type: 'assistant.delta', text: '完成' });

    const toolResult = events.find((event) => event.type === 'tool.result');
    expect(toolResult).toMatchObject({
      type: 'tool.result',
      result: { ok: true, content: 'echo:hi', name: 'echo' },
    });

    // 第二次请求必须能看到工具结果，否则模型没法继续。
    const secondRequest = model.requests[1];
    expect(secondRequest).toBeDefined();
    const lastMessage = secondRequest!.messages.at(-1);
    expect(lastMessage?.role).toBe('tool');

    // 最终历史里应该有 user / assistant / tool / assistant 四轮。
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('权限拒绝会变成一条可读的 observation，而不是异常', async () => {
    const model = new FakeModel([
      toolCallResponse([{ id: 'c1', name: 'echo', args: { text: 'hi' } }]),
      textResponse('好的，我换一种方式'),
    ]);
    const denyAll: PermissionGate = {
      async check() {
        return { decision: 'deny', source: 'test:deny' };
      },
    };

    const loop = new AgentLoop({
      model,
      modelId: 'fake',
      system: 'test',
      tools: registryWithEcho(),
      permissions: denyAll,
      cwd: process.cwd(),
      sessionId: 'test',
    });

    const { events, messages } = await collect(loop.run([userMessage('开始')]));

    const toolResult = events.find((event) => event.type === 'tool.result');
    expect(toolResult).toMatchObject({ result: { ok: false } });
    if (toolResult?.type === 'tool.result') {
      expect(toolResult.result.content).toContain('权限');
    }

    // 关键：模型真的收到了这条拒绝，并且能继续下一轮。
    const toolMessage = messages.find((message) => message.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(messages.at(-1)?.role).toBe('assistant');
  });

  it('达到步数上限就停下，不会无限循环', async () => {
    const model = new FakeModel(
      [
        toolCallResponse([{ id: 'c1', name: 'echo', args: { text: '1' } }]),
        toolCallResponse([{ id: 'c2', name: 'echo', args: { text: '2' } }]),
        toolCallResponse([{ id: 'c3', name: 'echo', args: { text: '3' } }]),
      ],
      { onExhausted: toolCallResponse([{ id: 'cx', name: 'echo', args: { text: 'x' } }]) },
    );

    const loop = new AgentLoop({
      model,
      modelId: 'fake',
      system: 'test',
      tools: registryWithEcho(),
      permissions: allowAll,
      cwd: process.cwd(),
      sessionId: 'test',
      maxSteps: 2,
    });

    const { events } = await collect(loop.run([userMessage('开始')]));

    const end = events.at(-1);
    expect(end).toEqual({ type: 'turn.end', reason: 'max_steps' });
    expect(model.requests).toHaveLength(2);
  });

  it('未知工具不会抛异常，而是变成错误结果的 observation', async () => {
    const model = new FakeModel([
      toolCallResponse([{ id: 'c1', name: 'nope', args: {} }]),
      textResponse('收到'),
    ]);

    const loop = new AgentLoop({
      model,
      modelId: 'fake',
      system: 'test',
      tools: registryWithEcho(),
      permissions: allowAll,
      cwd: process.cwd(),
      sessionId: 'test',
    });

    const { events } = await collect(loop.run([userMessage('开始')]));
    const toolResult = events.find((event) => event.type === 'tool.result');
    expect(toolResult).toMatchObject({ result: { ok: false } });
    if (toolResult?.type === 'tool.result') {
      expect(toolResult.result.content).toContain('未知工具');
    }
  });
});
