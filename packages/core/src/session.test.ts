import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { AgentEvent } from './protocol/events';
import type { PermissionRequest } from './protocol/permission';
import { snapshotDshPermissions } from './permissions/dsh-permissions';
import type { DshPermissionPreset, DshPermissionSnapshot } from './permissions/dsh-permissions';
import type { ModelClient, ModelRequest, ModelResponse } from './providers/types';
import { FakeModel, textResponse, toolCallResponse } from './providers/fake';
import { toOpenAIMessages } from './providers/openai';
import { Session } from './session';
import { SessionStore } from './session/store';
import { projectMessages } from './session/projection';
import { ToolRegistry } from './tools/registry';
import { z } from 'zod';
import type { Tool } from './domain/tool';
import type { AuditEntry } from './store/audit';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';

const noopTool: Tool = {
  name: 'noop',
  description: '什么都不做',
  parameters: z.object({}),
  mutating: false,
  async execute() {
    return { content: 'ok' };
  },
};

function snapshot(preset: DshPermissionPreset): DshPermissionSnapshot {
  return snapshotDshPermissions({ status: 'ready', preset });
}

async function temporaryWorkspace(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

function writeEscalation(id: string, path: string) {
  return {
    id,
    name: 'write_file',
    args: {
      path,
      content: 'approved content',
      sandbox_permissions: 'workspace-write',
      justification: 'Write the requested workspace file.',
    },
  };
}

async function collect(generator: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

function expectProviderToolCallsPaired(messages: ReturnType<typeof toOpenAIMessages>) {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && 'tool_calls' in message && message.tool_calls) {
      expect(pending.size).toBe(0);
      for (const call of message.tool_calls) pending.add(call.id);
    } else if (pending.size > 0 && message.role === 'tool') {
      expect(pending.delete(message.tool_call_id)).toBe(true);
    } else if (pending.size > 0) {
      expect.fail(`assistant tool calls were followed by ${message.role} before their results`);
    }
  }
  expect(pending.size).toBe(0);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForApproval<T>(asked: Promise<T>, turn: Promise<AgentEvent[]>): Promise<T> {
  const outcome = await Promise.race([
    asked.then((value) => ({ kind: 'asked' as const, value })),
    turn.then(() => ({ kind: 'ended' as const })),
  ]);
  if (outcome.kind === 'ended') throw new Error('Turn ended before requesting DSH escalation approval');
  return outcome.value;
}

describe('Session', () => {
  it('delegates a one-call sandbox widening to the UI approval callback', async () => {
    const root = await temporaryWorkspace('omniagent-session-approval-ui-');
    const handle = await new SessionStore(root).create({ id: 'agent', workspace: root, cwd: root });
    const asked: PermissionRequest[] = [];
    const escalation = writeEscalation('c1', 'approved.txt');
    escalation.args.justification = 'private-approval-justification';
    const model = new FakeModel([
      toolCallResponse([
        escalation,
        { id: 'c2', name: 'write_file', args: { path: 'later.txt', content: 'not approved' } },
      ]),
      textResponse('好了'),
    ]);

    const session = new Session({
      cwd: root,
      model,
      dshPermissions: snapshot('read-only'),
      approve: async (request) => {
        asked.push(request);
        return 'allow';
      },
      session: handle,
    });

    const events = await collect(session.send('开始'));

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      id: 'c1',
      call: { id: 'c1', name: 'write_file', arguments: escalation.args },
      reason: expect.stringContaining(escalation.args.justification),
    });
    expect(events.filter((event) => event.type === 'permission.decided')).toMatchObject([
      { callId: 'c1', decision: 'allow' }, { callId: 'c2', decision: 'allow' },
    ]);
    expect(events.filter((event) => event.type === 'tool.result').map((event) => event.result))
      .toMatchObject([{ callId: 'c1', ok: true }, { callId: 'c2', ok: false }]);
    expect(await readFile(join(root, 'approved.txt'), 'utf8')).toBe('approved content');
    await expect(readFile(join(root, 'later.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(session.dshPermissions).toEqual(snapshot('read-only'));
    const reopened = await new SessionStore(root).open(root, 'agent');
    const traces = reopened.events.filter((event) => event.type.startsWith('trace/'));
    expect(traces.find((event) => event.type === 'trace/permission.decided')?.data)
      .toEqual({ callId: 'c1', decision: 'allow' });
    expect(JSON.stringify(traces)).not.toContain(escalation.args.justification);
    expect(session.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('does not execute a rejected escalation and continues the conversation', async () => {
    const root = await temporaryWorkspace('omniagent-session-approval-denied-');
    const model = new FakeModel([
      toolCallResponse([writeEscalation('c1', 'rejected.txt')]),
      textResponse('那我换个办法'),
    ]);
    const approve = vi.fn(async () => 'deny' as const);

    const session = new Session({
      cwd: root,
      model,
      dshPermissions: snapshot('read-only'),
      approve,
    });

    const events = await collect(session.send('开始'));
    const result = events.find((event) => event.type === 'tool.result');

    expect(approve).toHaveBeenCalledOnce();
    expect(events.find((event) => event.type === 'permission.decided')).toMatchObject({
      callId: 'c1', decision: 'deny',
    });
    expect(result).toMatchObject({ result: { callId: 'c1', name: 'write_file', ok: false } });
    await expect(readFile(join(root, 'rejected.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(events.at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
  });

  it('denies calls without a DSH snapshot despite legacy bypass and allow rules', async () => {
    const execute = vi.fn(async () => ({ content: 'ok' }));
    const approve = vi.fn(async () => 'allow' as const);
    const session = new Session({
      cwd: process.cwd(),
      model: new FakeModel([toolCallResponse([{ id: 'c1', name: 'noop', args: {} }]), textResponse('done')]),
      tools: new ToolRegistry().register({ ...noopTool, execute }),
      mode: 'bypass',
      rules: [{ raw: '*', tool: '*', source: 'session', decision: 'allow', anchor: process.cwd() }],
      approve,
    });

    const events = await collect(session.send('start'));

    expect(events.find((event) => event.type === 'permission.decided')).toMatchObject({
      callId: 'c1', decision: 'deny', source: expect.stringMatching(/DSH permission selection is required/i),
    });
    expect(events.find((event) => event.type === 'tool.result')).toMatchObject({ result: { ok: false } });
    expect(execute).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
  });

  it('projects legacy message event names into resumable history', () => {
    const messages = projectMessages([
      { seq: 0, ts: 1, type: 'user/message', data: { text: 'legacy user' } },
      {
        seq: 1,
        ts: 2,
        type: 'assistant/message',
        data: { role: 'assistant', content: [{ type: 'text', text: 'legacy assistant' }], toolCalls: [] },
      },
      {
        seq: 2,
        ts: 3,
        type: 'tool/result',
        data: { callId: 'legacy-call', name: 'legacy_tool', ok: true, content: 'legacy result', truncated: false },
      },
    ]);

    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'legacy user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'legacy assistant' }], toolCalls: [] },
      { role: 'tool', results: [{ callId: 'legacy-call', name: 'legacy_tool', ok: true, content: 'legacy result', truncated: false }] },
    ]);
  });

  it('reopens a legacy session with projected conversation history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-legacy-'));
    const store = new SessionStore(root);
    const handle = await store.create({ id: 'agent', workspace: root, cwd: root });
    await handle.append({ type: 'user/message', data: { text: 'legacy user' } });
    await handle.append({
      type: 'assistant/message',
      data: { role: 'assistant', content: [{ type: 'text', text: 'legacy assistant' }], toolCalls: [] },
    });
    await handle.append({
      type: 'tool/result',
      data: { callId: 'legacy-call', name: 'legacy_tool', ok: true, content: 'legacy result', truncated: false },
    });

    const reopened = await store.open(root, 'agent');
    expect(projectMessages(reopened.events).map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('writes messages to the session log and rebuilds history after reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-'));
    const store = new SessionStore(root);
    const handle = await store.create({
      id: 'agent',
      workspace: root,
      cwd: root,
    });
    const session = new Session({
      cwd: root,
      model: new FakeModel([textResponse('持久化成功')]),
      dshPermissions: snapshot('read-only'),
      approve: async () => 'deny',
      session: handle,
    });

    await collect(session.send('保存这句话'));
    await handle.flush();

    const reopened = await store.open(root, 'agent');
    expect(projectMessages(reopened.events).map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(projectMessages(reopened.events)[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: '持久化成功' }],
    });
  });

  it('durably records live tool traces without duplicating arguments or output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-trace-'));
    const handle = await new SessionStore(root).create({ id: 'agent', workspace: root, cwd: root });
    const secretArgument = 'private-argument-value';
    const secretOutput = `private-output-${'x'.repeat(10_000)}`;
    const tool: Tool = {
      name: 'inspect',
      description: 'Inspect a value',
      parameters: z.object({ value: z.string() }),
      mutating: false,
      async execute() { return { content: secretOutput, truncated: true }; },
    };
    const audits: AuditEntry[] = [];
    const approve = vi.fn(async () => 'deny' as const);
    const session = new Session({
      cwd: root,
      model: new FakeModel([
        toolCallResponse([{ id: 'call-1', name: 'inspect', args: { value: secretArgument } }]),
        textResponse('done'),
      ]),
      tools: new ToolRegistry().register(tool),
      dshPermissions: snapshot('danger-full-access'),
      approve,
      audit: (entry) => { audits.push(entry); },
      session: handle,
    });

    const traced = new Set(['turn.start', 'tool.call', 'permission.decided', 'tool.result', 'turn.end']);
    const events: AgentEvent[] = [];
    for await (const event of session.send('inspect this')) {
      events.push(event);
      if (traced.has(event.type)) {
        const fresh = await new SessionStore(root).open(root, 'agent');
        expect(fresh.events.at(-1)?.type).toBe(`trace/${event.type}`);
      }
    }

    const reopened = await new SessionStore(root).open(root, 'agent');
    const traces = reopened.events.filter((event) => event.type.startsWith('trace/'));
    expect(traces.map((event) => event.type)).toEqual([
      'trace/turn.start', 'trace/tool.call', 'trace/permission.decided',
      'trace/tool.result', 'trace/turn.start', 'trace/turn.end',
    ]);
    expect(traces[0]?.data).toEqual({ step: 0 });
    expect(traces[1]?.data).toEqual({ id: 'call-1', name: 'inspect' });
    expect(traces[2]?.data).toEqual({ callId: 'call-1', decision: 'allow' });
    expect(traces[3]?.data).toEqual({
      callId: 'call-1', name: 'inspect', ok: true, truncated: true, durationMs: expect.any(Number),
    });
    expect(traces.at(-1)?.data).toEqual({ reason: 'end_turn' });
    expect(reopened.events.map((event) => event.seq)).toEqual(reopened.events.map((_, index) => index));
    expect(reopened.events.every((event) => Number.isInteger(event.ts) && event.ts > 0)).toBe(true);
    const traceText = JSON.stringify(traces);
    expect(traceText).not.toContain(secretArgument);
    expect(traceText).not.toContain(secretOutput);
    expect(traceText).not.toContain('private-output-ref');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ callId: 'call-1', tool: 'inspect', decision: 'allow', ok: true });
    expect(approve).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'tool.result')).toMatchObject({
      result: { content: secretOutput },
    });

    const previousMessages = projectMessages(reopened.events);
    expect(previousMessages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const resumedModel = new FakeModel([textResponse('resumed')]);
    const resumed = new Session({
      cwd: root, model: resumedModel, dshPermissions: snapshot('read-only'),
      approve: async () => 'deny', session: reopened,
    });
    await collect(resumed.send('continue'));
    expect(resumedModel.requests[0]?.messages.slice(0, -1)).toEqual(previousMessages);
    expect(resumed.messages).toEqual(projectMessages((await new SessionStore(root).open(root, 'agent')).events));
  });

  it('records compaction metadata before yielding the event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-compact-'));
    const handle = await new SessionStore(root).create({ id: 'agent', workspace: root, cwd: root });
    const session = new Session({
      cwd: root, model: new FakeModel([textResponse('done')]), dshPermissions: snapshot('read-only'),
      approve: async () => 'deny', contextWindowTokens: 8, retainContextTokens: 2, session: handle,
    });
    let compacted = false;
    for await (const event of session.send('sensitive conversation '.repeat(30))) {
      if (event.type !== 'context.compacted') continue;
      compacted = true;
      const fresh = await new SessionStore(root).open(root, 'agent');
      expect(fresh.events.at(-1)).toMatchObject({
        type: 'trace/context.compacted',
        data: { beforeTokens: event.beforeTokens, afterTokens: event.afterTokens },
      });
      expect(JSON.stringify(fresh.events.at(-1)?.data)).not.toContain('sensitive conversation');
    }
    expect(compacted).toBe(true);
  });

  it('records bounded, sanitized error traces without changing emitted model errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-error-'));
    const handle = await new SessionStore(root).create({ id: 'agent', workspace: root, cwd: root });
    const sensitiveError = `Bearer private-token ${'secret-content'.repeat(1000)}`;
    const model: ModelClient = {
      name: 'failing',
      async complete() { throw new Error(sensitiveError); },
    };
    const session = new Session({
      cwd: root, model, dshPermissions: snapshot('read-only'), approve: async () => 'deny', session: handle,
    });
    const events: AgentEvent[] = [];
    for await (const event of session.send('start')) {
      events.push(event);
      if (event.type === 'error') {
        const fresh = await new SessionStore(root).open(root, 'agent');
        expect(fresh.events.at(-1)).toMatchObject({ type: 'trace/error', data: { message: expect.any(String) } });
      }
    }
    expect(events.find((event) => event.type === 'error')).toEqual({ type: 'error', error: { message: sensitiveError } });
    const fresh = await new SessionStore(root).open(root, 'agent');
    const trace = fresh.events.find((event) => event.type === 'trace/error');
    expect(JSON.stringify(trace?.data)).not.toContain('private-token');
    expect(JSON.stringify(trace?.data)).not.toContain('secret-content');
    expect(JSON.stringify(trace?.data).length).toBeLessThan(256);
    expect(fresh.events.at(-1)).toMatchObject({ type: 'trace/turn.end', data: { reason: 'error' } });
  });

  it('interrupts an active model request and allows a fresh turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-interrupt-'));
    const handle = await new SessionStore(root).create({ id: 'agent', workspace: root, cwd: root });
    const started = deferred<void>();
    const requests: ModelRequest[] = [];
    const model: ModelClient = {
      name: 'interruptible',
      async complete(request): Promise<ModelResponse> {
        requests.push(request);
        if (requests.length > 1) {
          const response = textResponse('after interruption');
          return { message: response.message, usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' };
        }
        return new Promise<ModelResponse>((_, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          started.resolve();
        });
      },
    };
    const session = new Session({
      cwd: root, model, dshPermissions: snapshot('read-only'), approve: async () => 'deny', session: handle,
    });
    const first = collect(session.send('first'));
    await started.promise;
    session.interrupt();
    expect((await first).at(-1)).toEqual({ type: 'turn.end', reason: 'interrupted' });
    expect(requests[0]?.signal?.aborted).toBe(true);

    session.interrupt();
    const second = await collect(session.send('second'));
    expect(second.at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
    expect(requests[1]?.signal?.aborted).toBe(false);
    const reopened = await new SessionStore(root).open(root, 'agent');
    expect(reopened.events.filter((event) => event.type === 'trace/turn.end').map((event) => event.data))
      .toEqual([{ reason: 'interrupted' }, { reason: 'end_turn' }]);
    expect(session.messages).toEqual(projectMessages(reopened.events));
  });

  it('completes missing tool results before an in-memory continuation after approval interruption', async () => {
    const root = await temporaryWorkspace('omniagent-session-approval-replay-');
    const store = new SessionStore(root);
    const handle = await store.create({ id: 'agent', workspace: root, cwd: root });
    const asked = deferred<void>();
    const approval = deferred<'allow' | 'deny'>();
    const model = new FakeModel([
      toolCallResponse([writeEscalation('c1', 'pending.txt')]),
      textResponse('continued'),
    ]);
    const session = new Session({
      cwd: root,
      model,
      dshPermissions: snapshot('read-only'),
      approve: async () => { asked.resolve(); return approval.promise; },
      session: handle,
    });

    const first = collect(session.send('first'));
    try {
      await waitForApproval(asked.promise, first);
      session.interrupt();
      expect((await first).at(-1)).toEqual({ type: 'turn.end', reason: 'interrupted' });
      const beforeContinuation = (await store.open(root, 'agent')).events;

      await collect(session.send('continue'));

      const resumedMessages = model.requests[1]?.messages;
      expect(resumedMessages?.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
      expect(resumedMessages?.[1]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'c1', name: 'write_file' }] });
      expect(resumedMessages?.[2]).toMatchObject({
        role: 'tool',
        results: [{
          callId: 'c1',
          name: 'write_file',
          ok: false,
          content: expect.stringMatching(/unknown/i),
        }],
      });
      if (resumedMessages?.[2]?.role === 'tool') {
        expect(resumedMessages[2].results[0]?.content).toMatch(/may or may not have run/i);
      }
      const afterContinuation = (await store.open(root, 'agent')).events;
      expect(afterContinuation.slice(0, beforeContinuation.length)).toEqual(beforeContinuation);
      expect(beforeContinuation.some((event) => event.type === 'message/tool-result')).toBe(false);

      approval.resolve('allow');
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(readFile(join(root, 'pending.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      session.interrupt();
      approval.resolve('deny');
    }
  });

  it('completes missing results for a restored partial multi-tool batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-multitool-replay-'));
    const store = new SessionStore(root);
    const handle = await store.create({ id: 'agent', workspace: root, cwd: root });
    const executed: string[] = [];
    const tool: Tool = { ...noopTool, async execute() { executed.push('noop'); return { content: 'done' }; } };
    const firstModel = new FakeModel([
      toolCallResponse([
        { id: 'c1', name: 'noop', args: {} },
        { id: 'c2', name: 'noop', args: {} },
      ]),
    ]);
    const firstSession = new Session({
      cwd: root,
      model: firstModel,
      tools: new ToolRegistry().register(tool),
      dshPermissions: snapshot('danger-full-access'),
      approve: async () => 'deny',
      session: handle,
    });
    const firstTurn = firstSession.send('first');
    let event = await firstTurn.next();
    while (!event.done && event.value.type !== 'tool.result') event = await firstTurn.next();
    expect(event.value).toMatchObject({ type: 'tool.result', result: { callId: 'c1', ok: true } });
    await firstTurn.return(undefined);
    expect(executed).toHaveLength(1);

    const reopened = await new SessionStore(root).open(root, 'agent');
    const originalEvents = reopened.events;
    const resumedModel = new FakeModel([textResponse('continued')]);
    const resumed = new Session({
      cwd: root,
      model: resumedModel,
      tools: new ToolRegistry().register(tool),
      dshPermissions: snapshot('danger-full-access'),
      approve: async () => 'deny',
      session: reopened,
    });
    await collect(resumed.send('continue'));

    const resumedMessages = resumedModel.requests[0]?.messages;
    expect(resumedMessages?.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(resumedMessages?.[1]).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'c1', name: 'noop' }, { id: 'c2', name: 'noop' }],
    });
    expect(resumedMessages?.[2]).toMatchObject({
      role: 'tool',
      results: [
        { callId: 'c1', name: 'noop', ok: true, content: 'done' },
        { callId: 'c2', name: 'noop', ok: false, content: expect.stringMatching(/unknown/i) },
      ],
    });
    if (resumedMessages?.[2]?.role === 'tool') {
      expect(resumedMessages[2].results[1]?.content).toMatch(/may or may not have run/i);
    }
    const afterContinuation = (await new SessionStore(root).open(root, 'agent')).events;
    expect(afterContinuation.slice(0, originalEvents.length)).toEqual(originalEvents);
    expect(originalEvents.filter((entry) => entry.type === 'message/tool-result')).toHaveLength(1);
    expect(executed).toHaveLength(1);
  });

  it('repairs every incomplete historical batch without changing real result order or the transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-history-replay-'));
    const store = new SessionStore(root);
    const handle = await store.create({ id: 'agent', workspace: root, cwd: root });
    const firstBatch = toolCallResponse([
      { id: 'a', name: 'noop', args: {} },
      { id: 'b', name: 'noop', args: {} },
      { id: 'c', name: 'noop', args: {} },
    ], 'first batch').message;
    const secondBatch = toolCallResponse([
      { id: 'a', name: 'noop', args: {} },
      { id: 'd', name: 'noop', args: {} },
    ], 'second batch').message;
    const result = (callId: string, content: string) => ({
      callId, name: 'noop', ok: true, content, truncated: false,
    });
    for (const entry of [
      { type: 'user/message', data: { text: 'first' } },
      { type: 'assistant/message', data: firstBatch },
      { type: 'tool/result', data: result('b', 'real b') },
      { type: 'tool/result', data: result('b', 'duplicate b') },
      { type: 'tool/result', data: result('orphan', 'orphan') },
      { type: 'tool/result', data: result('a', 'real a') },
      { type: 'message/user', data: { text: 'second' } },
      { type: 'message/assistant', data: secondBatch },
      { type: 'message/tool-result', data: { result: result('d', 'real d') } },
      { type: 'message/user', data: { text: 'third' } },
      { type: 'message/assistant', data: textResponse('already answered').message },
    ]) {
      await handle.append(entry);
    }
    const reopened = await new SessionStore(root).open(root, 'agent');
    const originalEvents = reopened.events;
    const model = new FakeModel([textResponse('continued'), textResponse('continued again')]);
    const session = new Session({
      cwd: root, model, dshPermissions: snapshot('read-only'), approve: async () => 'deny', session: reopened,
    });

    await collect(session.send('continue'));

    const request = model.requests[0]!;
    const projected = toOpenAIMessages('system', request.messages);
    expect(projected.map((message) => message.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'tool', 'tool', 'user',
      'assistant', 'tool', 'tool', 'user', 'assistant', 'user',
    ]);
    const tools = projected.filter((message) => message.role === 'tool');
    expect(tools).toEqual([
      { role: 'tool', tool_call_id: 'b', content: 'real b' },
      { role: 'tool', tool_call_id: 'a', content: 'real a' },
      { role: 'tool', tool_call_id: 'c', content: expect.stringMatching(/unknown/i) },
      { role: 'tool', tool_call_id: 'd', content: 'real d' },
      { role: 'tool', tool_call_id: 'a', content: expect.stringMatching(/unknown/i) },
    ]);
    expect(request.messages[1]).toEqual(firstBatch);
    expect(request.messages[4]).toEqual(secondBatch);
    const afterContinuation = (await new SessionStore(root).open(root, 'agent')).events;
    expect(afterContinuation.slice(0, originalEvents.length)).toEqual(originalEvents);
    expect(session.messages).toEqual(projectMessages(afterContinuation));

    await collect(session.send('continue again'));
    expect(model.requests[1]?.messages.slice(0, -2)).toEqual(request.messages);
    expect(session.messages).toEqual(projectMessages((await new SessionStore(root).open(root, 'agent')).events));
  });

  it('omits orphan results and duplicate call IDs only from provider history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-orphan-replay-'));
    const store = new SessionStore(root);
    const handle = await store.create({ id: 'agent', workspace: root, cwd: root });
    const duplicateCalls = toolCallResponse([
      { id: 'same', name: 'noop', args: {} },
      { id: 'same', name: 'noop', args: {} },
    ]).message;
    const result = { callId: 'same', name: 'noop', ok: true, content: 'real result', truncated: false };
    await handle.append({ type: 'message/user', data: { text: 'first' } });
    await handle.append({ type: 'message/tool-result', data: { result } });
    await handle.append({ type: 'message/assistant', data: duplicateCalls });
    await handle.append({ type: 'message/tool-result', data: { result } });
    const originalEvents = handle.events;
    const model = new FakeModel([textResponse('continued')]);
    const session = new Session({
      cwd: root, model, dshPermissions: snapshot('read-only'), approve: async () => 'deny', session: handle,
    });

    await collect(session.send('continue'));

    const projected = toOpenAIMessages('system', model.requests[0]!.messages);
    expect(projected.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(projected[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'same' }] });
    expect(projected[3]).toEqual({ role: 'tool', tool_call_id: 'same', content: 'real result' });
    const afterContinuation = (await new SessionStore(root).open(root, 'agent')).events;
    expect(afterContinuation.slice(0, originalEvents.length)).toEqual(originalEvents);
    expect(session.messages).toEqual(projectMessages(afterContinuation));
  });

  it('repairs incomplete batches before compacting history for the next request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-compact-replay-'));
    const store = new SessionStore(root);
    const handle = await store.create({ id: 'agent', workspace: root, cwd: root });
    await handle.append({ type: 'message/user', data: { text: 'old conversation '.repeat(100) } });
    await handle.append({
      type: 'message/assistant',
      data: toolCallResponse([
        { id: 'c1', name: 'noop', args: {} },
        { id: 'c2', name: 'noop', args: {} },
      ]).message,
    });
    await handle.append({ type: 'message/tool-result', data: { result: {
      callId: 'c1', name: 'noop', ok: true, content: 'real result', truncated: false,
    } } });
    const model = new FakeModel([textResponse('continued'), textResponse('continued again')]);
    const session = new Session({
      cwd: root, model, dshPermissions: snapshot('read-only'), approve: async () => 'deny', session: handle,
      contextWindowTokens: 200, retainContextTokens: 150,
    });

    const events = await collect(session.send('continue'));

    expect(events.some((event) => event.type === 'context.compacted')).toBe(true);
    const projected = toOpenAIMessages('system', model.requests[0]!.messages);
    expectProviderToolCallsPaired(projected);
    expect(projected.filter((message) => message.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'real result' },
      { role: 'tool', tool_call_id: 'c2', content: expect.stringMatching(/unknown/i) },
    ]);
    const secondEvents = await collect(session.send('continue again'));
    expect(secondEvents.some((event) => event.type === 'context.compacted')).toBe(true);
    expectProviderToolCallsPaired(toOpenAIMessages('system', model.requests[1]!.messages));
  });

  it('interrupts pending approval without executing the tool, even if approval later resolves', async () => {
    const root = await temporaryWorkspace('omniagent-session-approval-');
    const handle = await new SessionStore(root).create({ id: 'agent', workspace: root, cwd: root });
    const asked = deferred<void>();
    const approval = deferred<'allow' | 'deny'>();
    const session = new Session({
      cwd: root,
      model: new FakeModel([toolCallResponse([writeEscalation('c1', 'pending.txt')]), textResponse('next')]),
      dshPermissions: snapshot('read-only'),
      approve: async () => { asked.resolve(); return approval.promise; },
      session: handle,
    });
    const first = collect(session.send('first'));
    try {
      await waitForApproval(asked.promise, first);
      session.interrupt();
      expect((await first).at(-1)).toEqual({ type: 'turn.end', reason: 'interrupted' });
      expect((await collect(session.send('second'))).at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
      approval.resolve('allow');
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(readFile(join(root, 'pending.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      const reopened = await new SessionStore(root).open(root, 'agent');
      expect(reopened.events.some((event) => event.type === 'trace/tool.result')).toBe(false);
      expect(session.messages).toEqual(projectMessages(reopened.events));
    } finally {
      session.interrupt();
      approval.resolve('deny');
    }
  }, 3000);

  it('passes the active turn signal to an approval handler and aborts it on interrupt', async () => {
    const root = await temporaryWorkspace('omniagent-session-approval-signal-');
    const asked = deferred<AbortSignal>();
    const session = new Session({
      cwd: root,
      model: new FakeModel([toolCallResponse([writeEscalation('c1', 'pending.txt')])]),
      dshPermissions: snapshot('read-only'),
      approve: async (_request, signal) => {
        asked.resolve(signal);
        return new Promise<'deny'>((resolve) => signal.addEventListener('abort', () => resolve('deny'), { once: true }));
      },
    });
    const turn = collect(session.send('first'));
    try {
      const signal = await waitForApproval(asked.promise, turn);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      session.interrupt();
      expect((await turn).at(-1)).toEqual({ type: 'turn.end', reason: 'interrupted' });
      expect(signal.aborted).toBe(true);
      await expect(readFile(join(root, 'pending.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      session.interrupt();
    }
  });

  it('removes the approval abort listener even if the handler never settles', async () => {
    const root = await temporaryWorkspace('omniagent-session-approval-listener-');
    const asked = deferred<void>();
    let turnSignal: AbortSignal | undefined;
    const model: ModelClient = {
      name: 'approval-listener',
      async complete(request) {
        turnSignal = request.signal;
        const response = toolCallResponse([writeEscalation('c1', 'pending.txt')]);
        return { message: response.message, usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'tool_use' };
      },
    };
    const session = new Session({
      cwd: root, model, dshPermissions: snapshot('read-only'),
      approve: async () => { asked.resolve(); return new Promise<'deny'>(() => {}); },
    });
    const turn = collect(session.send('first'));
    try {
      await waitForApproval(asked.promise, turn);
      expect(turnSignal).toBeInstanceOf(AbortSignal);
      const remove = vi.spyOn(turnSignal!, 'removeEventListener');
      expect(getEventListeners(turnSignal!, 'abort')).toHaveLength(1);
      session.interrupt();
      expect((await turn).at(-1)).toEqual({ type: 'turn.end', reason: 'interrupted' });
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(getEventListeners(turnSignal!, 'abort')).toHaveLength(0);
      await expect(readFile(join(root, 'pending.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      session.interrupt();
    }
  });

  it('stops before executing a tool when interrupted at an event boundary', async () => {
    const asked: PermissionRequest[] = [];
    let executions = 0;
    const tool: Tool = { ...noopTool, async execute() { executions += 1; return { content: 'ok' }; } };
    const session = new Session({
      cwd: process.cwd(),
      model: new FakeModel([toolCallResponse([{ id: 'c1', name: 'noop', args: {} }])]),
      tools: new ToolRegistry().register(tool),
      dshPermissions: snapshot('danger-full-access'),
      approve: async (request) => { asked.push(request); return 'allow'; },
    });
    const turn = session.send('first');
    let event = await turn.next();
    while (!event.done && event.value.type !== 'tool.call') event = await turn.next();
    expect(event.value).toMatchObject({ type: 'tool.call' });
    session.interrupt();
    expect((await collect(turn)).at(-1)).toEqual({ type: 'turn.end', reason: 'interrupted' });
    expect(asked).toHaveLength(0);
    expect(executions).toBe(0);
  });

  it('rejects overlapping sends and closes an abandoned turn without losing projected messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-overlap-'));
    const handle = await new SessionStore(root).create({ id: 'agent', workspace: root, cwd: root });
    const session = new Session({
      cwd: root, model: new FakeModel([textResponse('first response'), textResponse('second response')]),
      dshPermissions: snapshot('read-only'), approve: async () => 'deny', session: handle,
    });
    const first = session.send('first');
    let event = await first.next();
    while (!event.done && event.value.type !== 'assistant.message') event = await first.next();
    expect(event.value).toMatchObject({ type: 'assistant.message' });
    await expect(session.send('overlap').next()).rejects.toThrow(/already.*(active|running)/i);
    await first.return(undefined);

    let reopened = await new SessionStore(root).open(root, 'agent');
    expect(reopened.events.at(-1)).toMatchObject({ type: 'trace/turn.end', data: { reason: 'interrupted' } });
    expect(session.messages).toEqual(projectMessages(reopened.events));
    expect(session.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect((await collect(session.send('second'))).at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
    reopened = await new SessionStore(root).open(root, 'agent');
    expect(session.messages).toEqual(projectMessages(reopened.events));
    expect(projectMessages(reopened.events).map((message) => message.role))
      .toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it.each(['interrupt', 'close'] as const)('preserves tool audit when the consumer %ss after the result', async (action) => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-audit-'));
    const handle = await new SessionStore(root).create({ id: 'agent', workspace: root, cwd: root });
    const audits: AuditEntry[] = [];
    const session = new Session({
      cwd: root,
      model: new FakeModel([toolCallResponse([{ id: 'c1', name: 'noop', args: {} }]), textResponse('next')]),
      tools: new ToolRegistry().register(noopTool),
      dshPermissions: snapshot('danger-full-access'),
      approve: async () => 'allow',
      audit: (entry) => { audits.push(entry); },
      session: handle,
    });
    const turn = session.send('first');
    let event = await turn.next();
    while (!event.done && event.value.type !== 'tool.result') event = await turn.next();
    expect(event.value).toMatchObject({ type: 'tool.result' });
    if (action === 'interrupt') {
      session.interrupt();
      expect((await collect(turn)).at(-1)).toEqual({ type: 'turn.end', reason: 'interrupted' });
    } else {
      await turn.return(undefined);
    }
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ callId: 'c1', tool: 'noop', ok: true });
    const reopened = await new SessionStore(root).open(root, 'agent');
    expect(session.messages).toEqual(projectMessages(reopened.events));
    expect(reopened.events.at(-1)).toMatchObject({ type: 'trace/turn.end', data: { reason: 'interrupted' } });
    expect((await collect(session.send('second'))).at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
  });

  it('does not execute a second tool when interrupted after the first result', async () => {
    const calls: string[] = [];
    const audits: AuditEntry[] = [];
    const tool: Tool = { ...noopTool, async execute() { calls.push('executed'); return { content: 'ok' }; } };
    const session = new Session({
      cwd: process.cwd(),
      model: new FakeModel([toolCallResponse([
        { id: 'c1', name: 'noop', args: {} }, { id: 'c2', name: 'noop', args: {} },
      ])]),
      tools: new ToolRegistry().register(tool),
      dshPermissions: snapshot('danger-full-access'),
      approve: async () => 'allow',
      audit: (entry) => { audits.push(entry); },
    });
    const turn = session.send('first');
    let event = await turn.next();
    while (!event.done && event.value.type !== 'tool.result') event = await turn.next();
    expect(event.value).toMatchObject({ type: 'tool.result', result: { callId: 'c1' } });
    session.interrupt();
    expect((await collect(turn)).at(-1)).toEqual({ type: 'turn.end', reason: 'interrupted' });
    expect(calls).toEqual(['executed']);
    expect(audits.map((entry) => entry.callId)).toEqual(['c1']);
  });

  it('records an error termination when closed immediately after a model error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-error-close-'));
    const handle = await new SessionStore(root).create({ id: 'agent', workspace: root, cwd: root });
    const model: ModelClient = { name: 'failing', async complete() { throw new Error('private error'); } };
    const session = new Session({
      cwd: root, model, dshPermissions: snapshot('read-only'), approve: async () => 'deny', session: handle,
    });
    const turn = session.send('first');
    let event = await turn.next();
    while (!event.done && event.value.type !== 'error') event = await turn.next();
    expect(event.value).toMatchObject({ type: 'error' });
    await turn.return(undefined);
    const reopened = await new SessionStore(root).open(root, 'agent');
    expect(reopened.events.slice(-2).map(({ type, data }) => ({ type, data }))).toEqual([
      { type: 'trace/error', data: { message: expect.any(String) } },
      { type: 'trace/turn.end', data: { reason: 'error' } },
    ]);
  });

  it('records audit failures during generator close as errors and releases the turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-session-audit-error-'));
    const handle = await new SessionStore(root).create({ id: 'agent', workspace: root, cwd: root });
    const session = new Session({
      cwd: root,
      model: new FakeModel([toolCallResponse([{ id: 'c1', name: 'noop', args: {} }]), textResponse('next')]),
      tools: new ToolRegistry().register(noopTool),
      dshPermissions: snapshot('danger-full-access'),
      approve: async () => 'allow',
      audit: async () => { throw new Error('private audit failure'); },
      session: handle,
    });
    const turn = session.send('first');
    let event = await turn.next();
    while (!event.done && event.value.type !== 'tool.result') event = await turn.next();
    expect(event.value).toMatchObject({ type: 'tool.result' });
    await expect(turn.return(undefined)).rejects.toThrow('private audit failure');
    const reopened = await new SessionStore(root).open(root, 'agent');
    expect(reopened.events.slice(-2).map((entry) => entry.type)).toEqual(['trace/error', 'trace/turn.end']);
    expect(reopened.events.at(-1)?.data).toEqual({ reason: 'error' });
    expect(JSON.stringify(reopened.events.filter((entry) => entry.type.startsWith('trace/'))))
      .not.toContain('private audit failure');
    expect(session.messages).toEqual(projectMessages(reopened.events));
    expect((await collect(session.send('second'))).at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
  });

  it('records unexpected failures and releases the turn for a later send', async () => {
    const root = await temporaryWorkspace('omniagent-session-failure-');
    const handle = await new SessionStore(root).create({ id: 'agent', workspace: root, cwd: root });
    const secret = 'private-approval-error';
    const approve = vi.fn(async () => { throw new Error(secret); });
    const session = new Session({
      cwd: root,
      model: new FakeModel([toolCallResponse([writeEscalation('c1', 'failed.txt')]), textResponse('next')]),
      dshPermissions: snapshot('read-only'),
      approve,
      session: handle,
    });
    await expect(collect(session.send('first'))).rejects.toThrow(secret);
    expect(approve).toHaveBeenCalledOnce();
    await expect(readFile(join(root, 'failed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const failed = await new SessionStore(root).open(root, 'agent');
    expect(failed.events.slice(-2).map((event) => event.type)).toEqual(['trace/error', 'trace/turn.end']);
    expect(failed.events.at(-1)?.data).toEqual({ reason: 'error' });
    expect(JSON.stringify(failed.events.filter((event) => event.type.startsWith('trace/')))).not.toContain(secret);
    expect(session.messages).toEqual(projectMessages(failed.events));
    expect((await collect(session.send('second'))).at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
  });
});
