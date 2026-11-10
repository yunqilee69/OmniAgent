import { describe, expect, it, vi } from 'vitest';
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
  it.each([false, true])('measures each model request independently with streaming=%s', async (streaming) => {
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      let calls = 0;
      const respond = () => ++calls === 1
        ? toolCallResponse([{ id: 'c1', name: 'echo', args: { text: 'go' } }])
        : textResponse('done');
      const model = {
        name: 'timed',
        async complete() {
          clock += 25;
          const step = respond();
          return { ...step, usage: { inputTokens: 1, outputTokens: 2 }, stopReason: step.stopReason! };
        },
        ...(streaming ? { async *stream() {
          clock += 10;
          yield { type: 'text' as const, text: 'delta' };
          clock += 15;
          const step = respond();
          return { ...step, usage: { inputTokens: 1, outputTokens: 2 }, stopReason: step.stopReason! };
        } } : {}),
      };
      const loop = new AgentLoop({ model, modelId: 'timed', system: () => { clock += 500; return ''; },
        tools: registryWithEcho(), permissions: allowAll, cwd: process.cwd(), sessionId: 'test',
        contextWindowTokens: 8,
        prepareToolCall: async (call) => ({ decision: 'allow', source: 'test', execute: async () => {
          clock += 300;
          return { callId: call.id, name: call.name, ok: true, content: 'done', truncated: false };
        } }) });
      const generator = loop.run([userMessage('old '.repeat(300)), userMessage('current')]);
      const events: AgentEvent[] = [];
      let next = await generator.next();
      while (!next.done) {
        events.push(next.value);
        if (next.value.type === 'context.compacted') clock += 1000;
        next = await generator.next();
      }
      expect(events.some((event) => event.type === 'context.compacted')).toBe(true);
      const messages = next.value.filter((message) => message.role === 'assistant');
      expect(messages.at(-1)?.requestDurationMs).toBe(25);
      expect(events.filter((event) => event.type === 'assistant.message').map((event) =>
        event.type === 'assistant.message' && event.message.requestDurationMs)).toEqual([25, 25]);
    } finally {
      now.mockRestore();
    }
  });
  it.each([false, true])('projects queued images at each step with imageInput=%s', async (imageInput) => {
    const image = { type: 'image' as const, mediaType: 'image/png', data: 'steer-secret',
      fileName: 'steer.png', filePath: '.images/steer.png' };
    const steer: Message = { role: 'user', content: [image] };
    let drains = 0;
    const model = new FakeModel([
      toolCallResponse([{ id: 'c1', name: 'echo', args: { text: 'go' } }]), textResponse('done'),
    ]);
    const loop = new AgentLoop({ model, modelId: 'fake', imageInput, system: '', tools: registryWithEcho(),
      permissions: allowAll, cwd: process.cwd(), sessionId: 'test',
      takeQueuedMessages: () => ++drains === 2 ? [steer] : [] });
    const { messages } = await collect(loop.run([userMessage('start')]));
    expect(model.requests[0]?.messages).not.toContainEqual(steer);
    const received = model.requests[1]?.messages.at(-1);
    if (imageInput) expect(received).toEqual(steer);
    else {
      expect(received).toMatchObject({ role: 'user', content: [{ type: 'text', text: expect.stringContaining('.images/steer.png') }] });
      expect(JSON.stringify(model.requests[1]?.messages)).not.toContain('steer-secret');
    }
    expect(messages).toContainEqual(steer);
  });
  it.each([0, 4, 11, -1])('validates cached input count %s against total input', async (cachedInputTokens) => {
    const step = textResponse('done');
    const model = new FakeModel([{ ...step, usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens } }]);
    const loop = new AgentLoop({ model, modelId: 'fake', system: '', tools: registryWithEcho(),
      permissions: allowAll, cwd: process.cwd(), sessionId: 'test' });
    const { events } = await collect(loop.run([userMessage('hello')]));
    const message = events.find((event) => event.type === 'assistant.message');
    expect(message?.type === 'assistant.message' && message.message.usage).toEqual({
      inputTokens: 10, outputTokens: 2,
      ...(cachedInputTokens >= 0 && cachedInputTokens <= 10 ? { cachedInputTokens } : {}),
    });
  });

  it('persists the total prompt sample for both streamed and complete responses', async () => {
    for (const streaming of [false, true]) {
      const response = { message: { role: 'assistant' as const, content: [], toolCalls: [] },
        usage: { inputTokens: 4, outputTokens: 2 }, contextInputTokens: 10, stopReason: 'end_turn' as const };
      const model = { name: 'test-provider', complete: async () => response,
        ...(streaming ? { async *stream() { return response; } } : {}) };
      const loop = new AgentLoop({ model, modelId: 'test-model', system: 'system', tools: registryWithEcho(),
        permissions: allowAll, cwd: process.cwd(), sessionId: 'test' });
      const { messages } = await collect(loop.run([userMessage('hello')]));
      expect(messages.at(-1)).toMatchObject({ usage: { inputTokens: 10, outputTokens: 2 },
        contextSample: { provider: 'test-provider', model: 'test-model', historyHash: expect.any(String) } });
    }
  });

  it('does not treat missing usage represented by zero as measured', async () => {
    const model = new FakeModel([textResponse('done')]);
    const loop = new AgentLoop({ model, modelId: 'fake', system: '', tools: registryWithEcho(),
      permissions: allowAll, cwd: process.cwd(), sessionId: 'test' });
    const { messages } = await collect(loop.run([userMessage('hello')]));
    expect(messages.at(-1)).toHaveProperty('usage', { inputTokens: 0, outputTokens: 0 });
    expect(messages.at(-1)).not.toHaveProperty('contextSample');
  });
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

  it('把思考增量作为独立事件转发，且不混入正文', async () => {
    const model = new FakeModel([
      { ...textResponse('完成'), reasoning: '先想一下' },
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
    const reasoning = events.filter((event) => event.type === 'assistant.reasoning.delta');
    expect(reasoning.map((event) => (event.type === 'assistant.reasoning.delta' ? event.text : '')))
      .toEqual(['先想一下']);
    expect(events.filter((event) => event.type === 'assistant.delta').length).toBeGreaterThan(0);
    const message = events.find((event) => event.type === 'assistant.message');
    expect(message).toMatchObject({ message: { content: [{ type: 'text', text: '完成' }] } });
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

  it('sends a large image and question on the first vision request', async () => {
    const current: Message = { role: 'user', content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', mediaType: 'image/png', data: 'x'.repeat(4_000_000) },
    ] };
    const model = new FakeModel([textResponse('done')]);
    const loop = new AgentLoop({ model, modelId: 'fake', imageInput: true, system: '', tools: registryWithEcho(),
      permissions: allowAll, cwd: process.cwd(), sessionId: 'test', contextWindowTokens: 4000 });
    const { events } = await collect(loop.run([current]));
    expect(events.some((event) => event.type === 'context.compacted')).toBe(false);
    expect(model.requests[0]?.messages).toEqual([current]);
  });

  it('preserves the prompt and multiple steers across repeated compactions', async () => {
    const prompt = userMessage('prompt '.repeat(400));
    const steer1 = userMessage('steer one '.repeat(400));
    const steer2: Message = { role: 'user', content: [
      { type: 'text', text: 'steer two' }, { type: 'image', mediaType: 'image/png', data: 'x'.repeat(100_000) },
    ] };
    let drains = 0;
    const model = new FakeModel([
      toolCallResponse([{ id: 'c1', name: 'echo', args: { text: 'go' } }]),
      toolCallResponse([{ id: 'c2', name: 'echo', args: { text: 'go' } }]),
      textResponse('done'),
    ]);
    const loop = new AgentLoop({ model, modelId: 'fake', imageInput: true, system: '', tools: registryWithEcho(),
      permissions: allowAll, cwd: process.cwd(), sessionId: 'test', contextWindowTokens: 10,
      takeQueuedMessages: () => ++drains === 2 ? [steer1] : drains === 3 ? [steer2] : [] });
    const { events } = await collect(loop.run([userMessage('old '.repeat(1000)), prompt]));
    expect(events.filter((event) => event.type === 'context.compacted').length).toBeGreaterThanOrEqual(2);
    expect(model.requests[0]?.messages).toContainEqual(prompt);
    expect(model.requests[0]?.messages).not.toContainEqual(userMessage('old '.repeat(1000)));
    expect(model.requests[1]?.messages).toEqual(expect.arrayContaining([prompt, steer1]));
    expect(model.requests[2]?.messages).toEqual(expect.arrayContaining([prompt, steer1, steer2]));
  });

  it('does not compact text-model history based on image base64 size', async () => {
    const image = { type: 'image' as const, mediaType: 'image/png', data: 'x'.repeat(10_000), filePath: '.images/a.png' };
    const model = new FakeModel([textResponse('done')]);
    const loop = new AgentLoop({ model, modelId: 'fake', imageInput: false, system: '', tools: registryWithEcho(),
      permissions: allowAll, cwd: process.cwd(), sessionId: 'test', contextWindowTokens: 100 });
    const { events, messages } = await collect(loop.run([{ role: 'user', content: [image] }]));
    expect(events.some((event) => event.type === 'context.compacted')).toBe(false);
    expect(model.requests[0]?.messages[0]).toMatchObject({ role: 'user', content: [
      { type: 'text', text: expect.stringContaining('.images/a.png') },
    ] });
    expect(messages[0]).toEqual({ role: 'user', content: [image] });
  });

  it('compacts oversized history before the next provider request', async () => {
    const model = new FakeModel([textResponse('done')]);
    const loop = new AgentLoop({
      model,
      modelId: 'fake',
      system: 'test',
      tools: registryWithEcho(),
      permissions: allowAll,
      cwd: process.cwd(),
      sessionId: 'test',
      contextWindowTokens: 8,
      retainContextTokens: 2,
    });

    const current = userMessage('a'.repeat(300));
    const { events } = await collect(loop.run([userMessage('old '.repeat(300)), current]));

    expect(events.some((event) => event.type === 'context.compacted')).toBe(true);
    expect(model.requests[0]?.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: expect.stringContaining('summary') }],
    });
    expect(model.requests[0]?.messages.at(-1)).toEqual(current);
  });

  it('compacts on demand even when history is below the context window', async () => {
    const model = new FakeModel([textResponse('done')]);
    let pending = true;
    const loop = new AgentLoop({
      model,
      modelId: 'fake',
      system: 'test',
      tools: registryWithEcho(),
      permissions: allowAll,
      cwd: process.cwd(),
      sessionId: 'test',
      takeForceCompact: () => {
        const requested = pending;
        pending = false;
        return requested;
      },
    });

    const history = [userMessage('old '.repeat(200)), userMessage('recent '.repeat(200))];
    const { events } = await collect(loop.run(history));

    expect(pending).toBe(false);
    expect(events.some((event) => event.type === 'context.compacted')).toBe(true);
    expect(model.requests[0]?.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: expect.stringContaining('summary') }],
    });
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
