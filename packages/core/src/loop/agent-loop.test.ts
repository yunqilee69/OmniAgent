import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Message } from '../domain/message';
import { userMessage } from '../domain/message';
import type { Tool } from '../domain/tool';
import type { AuditEntry } from '../store/audit';
import type { AgentEvent } from '../protocol/events';
import type { PermissionGate } from '../protocol/permission';
import { ProviderRequestError } from '../providers/errors';
import { FakeModel, textResponse, toolCallResponse } from '../providers/fake';
import type { ModelClient, ModelResponse } from '../providers/types';
import { ToolRegistry } from '../tools/registry';
import { estimateMessageTokens, estimateMessages } from '../context/compaction';
import { contextBreakdown } from '../context/projection';
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

/**
 * Window that leaves exactly `messageBudget` tokens for messages.
 *
 * The loop derives that budget as `window - system - tools - outputReserve`, so
 * a raw window number in a test no longer means "history budget". These cases
 * pass `outputTokenReserveTokens: 0` to keep the arithmetic explicit.
 */
function windowForMessageBudget(
  messageBudget: number,
  options: { system?: string; tools?: ToolRegistry } = {},
): number {
  const breakdown = contextBreakdown(options.system ?? '', (options.tools ?? registryWithEcho()).specs(), []);
  return breakdown.systemTokens + breakdown.toolsTokens + messageBudget;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
        contextWindowTokens: windowForMessageBudget(8), outputTokenReserveTokens: 0,
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
      // Only a streamed request has an observable first packet; the blocking
      // path must not invent a TTFT.
      expect(events.filter((event) => event.type === 'assistant.message').map((event) =>
        event.type === 'assistant.message' && event.message.firstTokenDurationMs))
        .toEqual(streaming ? [10, 10] : [undefined, undefined]);
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
  it('retries a retryable model failure before any text is streamed', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const model: ModelClient = {
        name: 'flaky',
        async complete() {
          calls += 1;
          if (calls < 3) throw new ProviderRequestError('HTTP 503', { status: 503, code: 'overloaded' });
          const response = textResponse('recovered');
          return { message: response.message, stopReason: response.stopReason ?? 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
        },
      };
      const loop = new AgentLoop({
        model, modelId: 'fake', system: '', tools: registryWithEcho(), permissions: allowAll,
        cwd: process.cwd(), sessionId: 'test', maxRetries: 2,
      });
      const pending = collect(loop.run([userMessage('hello')]));
      await vi.runAllTimersAsync();
      const { events, messages } = await pending;
      expect(calls).toBe(3);
      expect(events.filter((event) => event.type === 'model.retry')).toHaveLength(2);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'recovered' }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a request that already streamed text, or a non-retryable failure', async () => {
    const streamed: ModelClient = {
      name: 'streamed',
      async complete() {
        const response = textResponse('unused');
        return { message: response.message, stopReason: response.stopReason ?? 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
      },
      async *stream(): AsyncGenerator<{ type: 'text'; text: string }, ModelResponse> {
        yield { type: 'text' as const, text: 'partial' };
        throw new ProviderRequestError('HTTP 503', { status: 503 });
      },
    };
    const denied: ModelClient = {
      name: 'denied',
      async complete() {
        throw new ProviderRequestError('HTTP 401', { status: 401, code: 'auth' });
      },
    };
    const streamedLoop = new AgentLoop({
      model: streamed, modelId: 'fake', system: '', tools: registryWithEcho(), permissions: allowAll,
      cwd: process.cwd(), sessionId: 'test', maxRetries: 3,
    });
    const deniedLoop = new AgentLoop({
      model: denied, modelId: 'fake', system: '', tools: registryWithEcho(), permissions: allowAll,
      cwd: process.cwd(), sessionId: 'test', maxRetries: 3,
    });
    const first = await collect(streamedLoop.run([userMessage('hello')]));
    const second = await collect(deniedLoop.run([userMessage('hello')]));
    expect(first.events.filter((event) => event.type === 'model.retry')).toHaveLength(0);
    expect(first.events.at(-1)).toMatchObject({ type: 'turn.end', reason: 'error' });
    expect(second.events.filter((event) => event.type === 'model.retry')).toHaveLength(0);
    expect(second.events.some((event) => event.type === 'error' && event.error.status === 401)).toBe(true);
  });

  it('stops after the configured retry budget is spent', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const model = {
        name: 'down',
        async complete() {
          calls += 1;
          throw new ProviderRequestError('HTTP 503', { status: 503, retryAfterMs: 5 });
        },
      };
      const loop = new AgentLoop({
        model, modelId: 'fake', system: '', tools: registryWithEcho(), permissions: allowAll,
        cwd: process.cwd(), sessionId: 'test', maxRetries: 1,
      });
      const pending = collect(loop.run([userMessage('hello')]));
      await vi.runAllTimersAsync();
      const { events } = await pending;
      expect(calls).toBe(2);
      expect(events.filter((event) => event.type === 'model.retry')).toEqual([
        expect.objectContaining({ attempt: 1, maxAttempts: 1, delayMs: 5 }),
      ]);
      expect(events.at(-1)).toMatchObject({ type: 'turn.end', reason: 'error' });
    } finally {
      vi.useRealTimers();
    }
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
      permissions: allowAll, cwd: process.cwd(), sessionId: 'test',
      contextWindowTokens: windowForMessageBudget(10), outputTokenReserveTokens: 0,
      takeQueuedMessages: () => ++drains === 2 ? [steer1] : drains === 3 ? [steer2] : [] });
    const { events } = await collect(loop.run([userMessage('old '.repeat(1000)), prompt]));
    expect(events.filter((event) => event.type === 'context.compacted').length).toBeGreaterThanOrEqual(2);
    expect(model.requests[0]?.messages).toContainEqual(prompt);
    expect(model.requests[0]?.messages).not.toContainEqual(userMessage('old '.repeat(1000)));
    expect(model.requests[1]?.messages).toEqual(expect.arrayContaining([prompt, steer1]));
    expect(model.requests[2]?.messages).toEqual(expect.arrayContaining([prompt, steer1, steer2]));
  });

  it.each([false, true])('charges an image by its visual cost, not by its base64 size, for imageInput=%s',
    async (imageInput) => {
      const image = { type: 'image' as const, mediaType: 'image/png', data: 'x'.repeat(10_000), filePath: '.images/a.png' };
      const imageMessage: Message = { role: 'user', content: [image] };
      const history = [userMessage('old '.repeat(100)), imageMessage];
      const model = new FakeModel([textResponse('done')]);
      const loop = new AgentLoop({ model, modelId: 'fake', imageInput, system: '', tools: registryWithEcho(),
        permissions: allowAll, cwd: process.cwd(), sessionId: 'test',
        contextWindowTokens: windowForMessageBudget(200), outputTokenReserveTokens: 0 });
      const { events } = await collect(loop.run(history));
      // A text-only model sees a short placeholder, so the budget is plenty. An
      // image model is charged the fixed visual cost and must compact — with the
      // 10k characters of base64 charged as one image, not as 2.5k tokens.
      expect(events.some((event) => event.type === 'context.compacted')).toBe(imageInput);
      const sent = model.requests[0]?.messages ?? [];
      if (imageInput) {
        expect(sent).toContainEqual(imageMessage);
        expect(sent[0]).toMatchObject({
          role: 'user',
          content: [{ type: 'text', text: expect.stringContaining('summary') }],
        });
      } else {
        expect(sent[0]).toEqual(history[0]);
        expect(sent.at(-1)).toMatchObject({ role: 'user', content: [
          { type: 'text', text: expect.stringContaining('.images/a.png') },
        ] });
        expect(JSON.stringify(sent)).not.toContain('x'.repeat(100));
      }
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
      contextWindowTokens: windowForMessageBudget(8, { system: 'test' }),
      outputTokenReserveTokens: 0,
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

  it('compacts against the window minus the prompt, the tools and the output reserve', async () => {
    const system = 'test';
    const tools = registryWithEcho();
    const overhead = contextBreakdown(system, tools.specs(), []);
    const window = 300_000;
    const reserve = 8_000;
    const messageBudget = window - overhead.systemTokens - overhead.toolsTokens - reserve;
    // Just over the derived budget but still below the raw window: exactly the
    // range the old "window == message budget" rule never compacted.
    const history = [userMessage('x'.repeat(1_170_000)), userMessage('current')];
    const before = estimateMessages(history);
    expect(before).toBeGreaterThan(messageBudget);
    expect(before).toBeLessThan(window);

    const model = new FakeModel([textResponse('done')]);
    const loop = new AgentLoop({ model, modelId: 'fake', system, tools, permissions: allowAll,
      cwd: process.cwd(), sessionId: 'test', contextWindowTokens: window, outputTokenReserveTokens: reserve });
    const { events } = await collect(loop.run(history));

    const compacted = events.find((event) => event.type === 'context.compacted');
    expect(compacted).toMatchObject({ type: 'context.compacted', beforeTokens: before });
    expect(model.requests[0]?.messages[0]).toMatchObject({
      role: 'user', content: [{ type: 'text', text: expect.stringContaining('summary') }],
    });
    // The request that actually goes out is inside the window, which is the
    // point of deriving the budget instead of using the window as the budget.
    expect(estimateMessages(model.requests[0]?.messages ?? [])).toBeLessThan(window);

    // The same window leaves a small history alone: the trigger is the derived
    // budget, not a fraction of the window.
    const smallModel = new FakeModel([textResponse('done')]);
    const smallLoop = new AgentLoop({ model: smallModel, modelId: 'fake', system, tools, permissions: allowAll,
      cwd: process.cwd(), sessionId: 'test', contextWindowTokens: window, outputTokenReserveTokens: reserve });
    const small = await collect(smallLoop.run([userMessage('x'.repeat(10_000))]));
    expect(small.events.some((event) => event.type === 'context.compacted')).toBe(false);
  });

  it('fails the turn before calling the provider when the window cannot hold a message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tools = registryWithEcho();
      const overhead = contextBreakdown('test', tools.specs(), []);
      // A window barely above the overhead: even the clamped reserve (half the
      // window) leaves no room for a message.
      const window = overhead.systemTokens + overhead.toolsTokens + 40;
      const reserve = Math.min(1_000, Math.floor(window / 2));
      const rawBudget = window - overhead.systemTokens - overhead.toolsTokens - reserve;
      expect(rawBudget).toBeLessThan(1);
      const model = new FakeModel([textResponse('never sent')]);
      const loop = new AgentLoop({ model, modelId: 'fake', system: 'test', tools, permissions: allowAll,
        cwd: process.cwd(), sessionId: 'test', contextWindowTokens: window, outputTokenReserveTokens: 1_000 });

      const { events, messages } = await collect(loop.run([userMessage('hello')]));

      expect(events.map((event) => event.type)).toEqual(['turn.start', 'error', 'turn.end']);
      const error = events[1];
      expect(error).toMatchObject({ type: 'error', error: { code: 'CONTEXT_BUDGET_TOO_SMALL' } });
      const message = error?.type === 'error' ? error.error.message : '';
      expect(message).toContain(`window=${window}`);
      expect(message).toContain(`system=${overhead.systemTokens}`);
      expect(message).toContain(`tools=${overhead.toolsTokens}`);
      expect(message).toContain(`outputReserve=${reserve}`);
      expect(message).toContain(`remaining=${rawBudget}`);
      expect(message).toMatch(/raise/i);
      expect(events.at(-1)).toEqual({ type: 'turn.end', reason: 'error' });
      // Nothing was sent and nothing was compacted: the turn ended instead of
      // clamping the budget to one message and overflowing the window.
      expect(model.requests).toHaveLength(0);
      expect(messages).toEqual([userMessage('hello')]);
      expect(warn.mock.calls.filter(([line]) => String(line).includes('CONTEXT_BUDGET_TOO_SMALL')
        || String(line).includes('Context budget too small'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('warns once per turn and stays quiet when no window is configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const model = new FakeModel([
        toolCallResponse([{ id: 'c1', name: 'echo', args: { text: 'go' } }]),
        textResponse('done'),
      ]);
      const loop = new AgentLoop({ model, modelId: 'fake', system: '', tools: registryWithEcho(),
        permissions: allowAll, cwd: process.cwd(), sessionId: 'test' });
      const { events } = await collect(loop.run([userMessage('hello')]));
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(events.some((event) => event.type === 'context.compacted')).toBe(false);
      expect(warn.mock.calls.filter(([line]) => String(line).includes('no context window configured')))
        .toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('warns once when the request is over budget but nothing can be compacted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tools = registryWithEcho();
      const budget = 100;
      const model = new FakeModel([textResponse('done')]);
      const loop = new AgentLoop({ model, modelId: 'fake', system: '', tools, permissions: allowAll,
        cwd: process.cwd(), sessionId: 'test',
        contextWindowTokens: windowForMessageBudget(budget), outputTokenReserveTokens: 0 });
      // The only message is the current user message, which is always protected.
      const { events } = await collect(loop.run([userMessage('a'.repeat(1_000))]));
      expect(events.some((event) => event.type === 'context.compacted')).toBe(false);
      // Over budget is a warning, not a fatal error: the turn still completes.
      expect(events.at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
      const warnings = warn.mock.calls.map(([line]) => String(line))
        .filter((line) => line.includes('compaction made no progress'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('before=');
      expect(warnings[0]).toContain(`budget=${budget}`);
      expect(warnings[0]).toContain('removed=0');
      expect(warnings[0]).toContain('reason=no-removable-group');
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when a summary would not shrink an over-budget request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tools = registryWithEcho();
      const budget = 100;
      const model = new FakeModel([textResponse('done')]);
      const loop = new AgentLoop({ model, modelId: 'fake', system: '', tools, permissions: allowAll,
        cwd: process.cwd(), sessionId: 'test',
        contextWindowTokens: windowForMessageBudget(budget), outputTokenReserveTokens: 0 });
      // A tiny removable prefix plus a protected message that alone exceeds the
      // budget: the summary is larger than what it replaces.
      const { events } = await collect(loop.run([userMessage('a'), userMessage('d'.repeat(1_000))]));
      expect(events.some((event) => event.type === 'context.compacted')).toBe(false);
      expect(events.at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
      const warnings = warn.mock.calls.map(([line]) => String(line))
        .filter((line) => line.includes('compaction made no progress'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('reason=no-reduction');
    } finally {
      warn.mockRestore();
    }
  });

  it('publishes the request history at every point the loop changes it', async () => {
    const snapshots: Message[][] = [];
    const steer = userMessage('steer');
    let drains = 0;
    const model = new FakeModel([
      toolCallResponse([{ id: 'c1', name: 'echo', args: { text: 'go' } }]),
      toolCallResponse([{ id: 'c2', name: 'echo', args: { text: 'again' } }]),
      textResponse('done'),
    ]);
    const loop = new AgentLoop({ model, modelId: 'fake', system: '', tools: registryWithEcho(),
      permissions: allowAll, cwd: process.cwd(), sessionId: 'test',
      takeQueuedMessages: () => ++drains === 2 ? [steer] : [],
      afterToolBatch: async () => [userMessage('batch settled')],
      onTurnHistory: (messages) => snapshots.push([...messages]) });

    const { messages } = await collect(loop.run([userMessage('start')]));

    // Entry, then per step: assistant, tool batch, settled batch, plus the
    // queued steer pushed before step two.
    expect(snapshots).toHaveLength(9);
    expect(snapshots[0]).toEqual([userMessage('start')]);
    expect(snapshots[1]?.at(-1)).toMatchObject({ role: 'assistant' });
    expect(snapshots[2]?.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(snapshots[3]?.at(-1)).toEqual(userMessage('batch settled'));
    expect(snapshots[4]).toEqual(snapshots[3]!.concat([steer]));
    expect(snapshots.at(-1)?.at(-1)).toMatchObject({
      role: 'assistant', content: [{ type: 'text', text: 'done' }],
    });
    // The observers get copies: the loop keeps mutating its own array.
    expect(snapshots.at(-1)).not.toBe(messages);
    expect(snapshots.at(-1)).toEqual(messages);
  });

  it('publishes the compacted history right after compacting', async () => {
    const snapshots: Array<{ types: string[]; messages: Message[] }> = [];
    const model = new FakeModel([textResponse('done')]);
    const loop = new AgentLoop({ model, modelId: 'fake', system: '', tools: registryWithEcho(),
      permissions: allowAll, cwd: process.cwd(), sessionId: 'test',
      contextWindowTokens: windowForMessageBudget(8), outputTokenReserveTokens: 0,
      onTurnHistory: (messages) => snapshots.push({ types: [], messages: [...messages] }) });
    const generator = loop.run([userMessage('old '.repeat(300)), userMessage('current')]);
    const types: string[] = [];
    let next = await generator.next();
    while (!next.done) {
      types.push(next.value.type);
      next = await generator.next();
    }
    // The first snapshot is the raw history; the summary replaces it before the
    // compaction event is emitted, so a reader never sees a stale pre-compaction
    // layout after the event.
    expect(snapshots[0]?.messages[0]).toEqual(userMessage('old '.repeat(300)));
    const compactedIndex = snapshots.findIndex((snapshot) => snapshot.messages[0]?.role === 'user'
      && snapshot.messages[0].content[0]?.type === 'text' && snapshot.messages[0].content[0].text.includes('summary'));
    expect(compactedIndex).toBeGreaterThan(0);
    expect(types[types.indexOf('context.compacted') - 1]).toBe('turn.start');
    expect(snapshots.at(-1)?.messages.length).toBe(3);
  });

  it('aborts before evaluating a model call', async () => {
    const controller = new AbortController();
    let called = false;
    const model: ModelClient = {
      name: 'preflight',
      complete() { called = true; throw new Error('complete must not be called'); },
      stream() { called = true; throw new Error('stream must not be called'); },
    };
    const loop = new AgentLoop({ model, modelId: 'preflight', system: '', tools: registryWithEcho(),
      permissions: allowAll, cwd: process.cwd(), sessionId: 'test' });
    const generator = loop.run([userMessage('go')], controller.signal);
    expect((await generator.next()).value).toMatchObject({ type: 'turn.start' });
    controller.abort();
    expect((await generator.next()).value).toEqual({ type: 'turn.end', reason: 'interrupted' });
    expect(called).toBe(false);
  });

  it('releases a provider that ignores abort and closes its iterator', async () => {
    const controller = new AbortController();
    let closed = false;
    const model: ModelClient = {
      name: 'stuck',
      async complete() { throw new Error('complete is not used'); },
      async *stream() {
        try {
          yield { type: 'text' as const, text: 'partial' };
          await new Promise<void>(() => undefined);
          yield { type: 'text' as const, text: 'late' };
          return { message: textResponse('late complete').message, usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' as const };
        } finally {
          closed = true;
        }
      },
    };
    const loop = new AgentLoop({ model, modelId: 'stuck', system: '', tools: registryWithEcho(),
      permissions: allowAll, cwd: process.cwd(), sessionId: 'test' });
    const generator = loop.run([userMessage('go')], controller.signal);
    const events: AgentEvent[] = [];
    const first = await generator.next();
    if (!first.done) events.push(first.value);
    const second = await generator.next();
    if (!second.done) events.push(second.value);
    controller.abort();
    const third = await Promise.race([
      generator.next(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('stream did not release')), 500)),
    ]);
    if (!third.done) events.push(third.value);
    expect(closed).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['turn.start', 'assistant.delta', 'turn.end']);
    expect(events.at(-1)).toMatchObject({ reason: 'interrupted' });
  });

  it('does not execute a tool when aborted after its allow decision is consumed', async () => {
    const controller = new AbortController();
    let executions = 0;
    const audits: AuditEntry[] = [];
    const model = new FakeModel([
      toolCallResponse([
        { id: 'c1', name: 'echo', args: { text: 'one' } },
        { id: 'c2', name: 'echo', args: { text: 'two' } },
      ]),
    ]);
    const loop = new AgentLoop({
      model, modelId: 'fake', system: '', tools: registryWithEcho(), permissions: allowAll,
      cwd: process.cwd(), sessionId: 'test',
      prepareToolCall: async (call) => ({
        decision: 'allow', source: 'test', execute: async () => {
          executions += 1;
          return { callId: call.id, name: call.name, ok: true, content: 'started', truncated: false };
        },
      }),
      audit: (entry) => { audits.push(entry); },
    });
    const generator = loop.run([userMessage('start')], controller.signal);
    let next = await generator.next();
    while (!next.done && !(next.value.type === 'permission.decided' && next.value.decision === 'allow')) {
      next = await generator.next();
    }
    expect(next.value).toMatchObject({ type: 'permission.decided', callId: 'c1', decision: 'allow' });
    controller.abort();
    next = await generator.next();
    const events = next.done ? [] : [next.value];
    expect(events).toEqual([{ type: 'turn.end', reason: 'interrupted' }]);
    expect(executions).toBe(0);
    expect(audits).toEqual([]);
    expect(model.requests).toHaveLength(1);
  });

  it('keeps only the started execution when aborted before the next tool', async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    const release = deferred<void>();
    const executions: string[] = [];
    const audits: AuditEntry[] = [];
    const model = new FakeModel([
      toolCallResponse([
        { id: 'c1', name: 'echo', args: { text: 'one' } },
        { id: 'c2', name: 'echo', args: { text: 'two' } },
      ]),
    ]);
    const loop = new AgentLoop({
      model, modelId: 'fake', system: '', tools: registryWithEcho(), permissions: allowAll,
      cwd: process.cwd(), sessionId: 'test',
      prepareToolCall: async (call) => ({
        decision: 'allow', source: 'test', execute: async () => {
          executions.push(call.id);
          if (call.id === 'c1') {
            started.resolve();
            await release.promise;
          }
          return { callId: call.id, name: call.name, ok: true, content: call.id, truncated: false };
        },
      }),
      audit: (entry) => { audits.push(entry); },
    });
    const generator = loop.run([userMessage('start')], controller.signal);
    const running = collect(generator);
    await started.promise;
    controller.abort();
    release.resolve();
    const { events } = await running;
    expect(events.filter((event) => event.type === 'tool.result')).toMatchObject([
      { result: { callId: 'c1', ok: true, content: 'c1' } },
    ]);
    expect(events.filter((event) => event.type === 'turn.end')).toEqual([
      { type: 'turn.end', reason: 'interrupted' },
    ]);
    expect(executions).toEqual(['c1']);
    expect(audits).toMatchObject([{ callId: 'c1', tool: 'echo', decision: 'allow', ok: true }]);
    expect(model.requests).toHaveLength(1);
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
