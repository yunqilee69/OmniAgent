import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInitialDshPermissionEvent, FakeModel, projectDshPermissions, Session, SessionStore,
  snapshotDshPermissions, textResponse, toolCallResponse,
} from '@omniagent/core';
import type { AgentEvent, DshPermissionPreset, PermissionRequest } from '@omniagent/core';

import { ApprovalBroker } from './approval';

type Broker = ApprovalBroker;

const roots: string[] = [];
const snapshot = (preset: DshPermissionPreset) =>
  snapshotDshPermissions(projectDshPermissions([createInitialDshPermissionEvent(preset)]));

async function temporaryRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'omniagent-web-approval-')));
  roots.push(root);
  return root;
}

function writeCall(id = 'same-model-id', path = 'approval.txt', content = 'private-argument') {
  return { id, name: 'write_file', args: {
    path, content, sandbox_permissions: 'workspace-write', justification: 'Write the requested file',
  } };
}

async function expectMissing(workspace: string, path = 'approval.txt') {
  await expect(readFile(join(workspace, path))).rejects.toMatchObject({ code: 'ENOENT' });
}

const request: PermissionRequest = {
  id: 'same-model-id',
  call: { id: 'same-model-id', name: 'write_file', arguments: writeCall().args, raw: 'private-raw' },
  reason: 'private-rule',
  matchedRule: { raw: 'private-rule', decision: 'ask', source: 'user', tool: 'write_file', anchor: '/private' },
};

async function nextRequest(iterator: AsyncGenerator<AgentEvent>) {
  const prior: AgentEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error('Turn ended without a permission request');
    if (next.value.type === 'permission.requested') return { prompt: next.value, prior };
    prior.push(next.value);
  }
}

async function remaining(iterator: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of iterator) events.push(event);
  return events;
}

async function fixture(
  broker: Broker, workspace: string, sessionId: string,
  calls: Array<{ id: string; name: string; args: unknown }> = [writeCall()],
) {
  const root = await temporaryRoot();
  const store = new SessionStore(root);
  const handle = await store.create({ id: sessionId, workspace, cwd: workspace });
  const session = new Session({
    cwd: workspace, dshPermissions: snapshot('read-only'),
    model: new FakeModel([toolCallResponse(calls), textResponse('done')], { onExhausted: textResponse('next') }),
    approve: broker.handler(workspace, sessionId),
    session: handle,
  });
  const turn = broker.start(workspace, sessionId);
  return { session, turn, stream: turn.stream(session.send('run')), store };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('web approval broker', () => {
  it('provides a broker for live correlated approvals', async () => {
    expect(ApprovalBroker).toBeTypeOf('function');
  });

  it('streams a live-only request and executes a tool only after an explicit allow', async () => {
    const broker = new ApprovalBroker();
    const workspace = await temporaryRoot();
    const f = await fixture(broker, workspace, 'session');
    const { prompt, prior } = await nextRequest(f.stream);
    expect(prior.map((event) => event.type)).toContain('tool.call');
    expect(prompt).toEqual({
      type: 'permission.requested', requestId: expect.any(String),
      call: { id: 'same-model-id', name: 'write_file', arguments: writeCall().args },
      reason: expect.any(String),
    });
    expect(prompt.requestId).not.toBe(prompt.call.id);
    await expectMissing(workspace);
    expect(broker.respond(workspace, 'session', prompt.requestId, 'allow')).toBe(true);
    expect(broker.respond(workspace, 'session', prompt.requestId, 'allow')).toBe(false);
    const events = await remaining(f.stream);
    expect(await readFile(join(workspace, 'approval.txt'), 'utf8')).toBe('private-argument');
    expect(events.find((event) => event.type === 'permission.decided')).toMatchObject({ decision: 'allow' });
    expect(events.find((event) => event.type === 'tool.result')).toMatchObject({ result: { ok: true } });
    const reopened = await f.store.open(workspace, 'session');
    const traces = reopened.events.filter((event) => event.type.startsWith('trace/'));
    expect(JSON.stringify(traces)).not.toContain(prompt.requestId);
    expect(JSON.stringify(traces)).not.toContain('private-argument');
    expect(reopened.events.some((event) => event.type.includes('permission.requested'))).toBe(false);
  });

  it('correlates fresh request IDs even when the model repeats a call ID', async () => {
    const broker = new ApprovalBroker();
    const workspace = await temporaryRoot();
    const f = await fixture(broker, workspace, 'session', [
      writeCall('same-model-id', 'first.txt', 'first'),
      { id: 'ordinary', name: 'write_file', args: { path: 'ordinary.txt', content: 'blocked' } },
      writeCall('same-model-id', 'second.txt', 'second'),
    ]);
    const first = (await nextRequest(f.stream)).prompt;
    expect(broker.respond(workspace, 'session', first.requestId, 'allow')).toBe(true);
    const { prompt: second, prior } = await nextRequest(f.stream);
    expect(second.requestId).not.toBe(first.requestId);
    expect(await readFile(join(workspace, 'first.txt'), 'utf8')).toBe('first');
    expect(prior.find((event) => event.type === 'tool.result' && event.result.callId === 'ordinary'))
      .toMatchObject({ result: { ok: false } });
    await expectMissing(workspace, 'ordinary.txt');
    await expectMissing(workspace, 'second.txt');
    expect(broker.respond(workspace, 'session', first.requestId, 'allow')).toBe(false);
    expect(broker.respond(workspace, 'session', second.requestId, 'deny')).toBe(true);
    const events = await remaining(f.stream);
    expect(events.find((event) => event.type === 'permission.decided')).toMatchObject({ decision: 'deny' });
    await expectMissing(workspace, 'second.txt');
  });

  it('isolates same-named sessions across workspaces and other sessions in the same workspace', async () => {
    const broker = new ApprovalBroker();
    const workspaceA = await temporaryRoot();
    const workspaceB = await temporaryRoot();
    const a = await fixture(broker, workspaceA, 'same');
    const b = await fixture(broker, workspaceB, 'same');
    const c = await fixture(broker, workspaceA, 'other');
    const [pa, pb, pc] = await Promise.all([nextRequest(a.stream), nextRequest(b.stream), nextRequest(c.stream)]);
    expect(broker.respond(workspaceB, 'same', pa.prompt.requestId, 'allow')).toBe(false);
    expect(broker.respond(workspaceA, 'other', pa.prompt.requestId, 'allow')).toBe(false);
    expect(broker.respond(workspaceA, 'same', pa.prompt.requestId, 'always')).toBe(false);
    await expectMissing(workspaceA);
    await expectMissing(workspaceB);
    expect(broker.respond(workspaceA, 'same', pa.prompt.requestId, 'deny')).toBe(true);
    expect(broker.respond(workspaceB, 'same', pb.prompt.requestId, 'allow')).toBe(true);
    expect(broker.respond(workspaceA, 'other', pc.prompt.requestId, 'deny')).toBe(true);
    await Promise.all([remaining(a.stream), remaining(b.stream), remaining(c.stream)]);
    await expectMissing(workspaceA);
    expect(await readFile(join(workspaceB, 'approval.txt'), 'utf8')).toBe('private-argument');
  });

  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)(
    'runs ordinary calls without prompting under %s', async (preset) => {
      const broker = new ApprovalBroker();
      const workspace = await temporaryRoot();
      await writeFile(join(workspace, 'input.txt'), 'readable content');
      const calls: Array<{ id: string; name: string; args: unknown }> = [
        { id: 'read', name: 'read_file', args: { path: 'input.txt' } },
        { id: 'write', name: 'write_file', args: { path: 'ordinary.txt', content: 'ordinary write' } },
      ];
      if (preset === 'danger-full-access') {
        const escalation = writeCall('escalation', 'escalation.txt');
        calls.push({ ...escalation, args: { ...escalation.args, sandbox_permissions: 'danger-full-access' } });
      }
      const session = new Session({
        cwd: workspace, dshPermissions: snapshot(preset), approve: broker.handler(workspace, 'session'),
        model: new FakeModel([toolCallResponse(calls), textResponse('done')]),
      });
      const events = await remaining(broker.start(workspace, 'session').stream(session.send('run')));
      expect(events.filter((event) => event.type === 'permission.requested')).toEqual([]);
      expect(events.filter((event) => event.type === 'tool.result').map((event) => event.result.ok))
        .toEqual(preset === 'danger-full-access' ? [true, true, false] : [true, preset === 'workspace-write']);
      expect(events.find((event) => event.type === 'tool.result')).toMatchObject({
        result: { callId: 'read', content: expect.stringContaining('readable content') },
      });
      if (preset === 'read-only') await expectMissing(workspace, 'ordinary.txt');
      else expect(await readFile(join(workspace, 'ordinary.txt'), 'utf8')).toBe('ordinary write');
      if (preset === 'danger-full-access') await expectMissing(workspace, 'escalation.txt');
    },
  );

  it('prompts for a wider one-call escalation under workspace-write', async () => {
    const broker = new ApprovalBroker();
    const workspace = await temporaryRoot();
    const call = writeCall('wider');
    const session = new Session({
      cwd: workspace, dshPermissions: snapshot('workspace-write'), approve: broker.handler(workspace, 'session'),
      model: new FakeModel([
        toolCallResponse([{ ...call, args: { ...call.args, sandbox_permissions: 'danger-full-access' } }]),
        textResponse('done'),
      ]),
    });
    const stream = broker.start(workspace, 'session').stream(session.send('run'));
    const prompt = (await nextRequest(stream)).prompt;
    expect(prompt.call.arguments).toMatchObject({ sandbox_permissions: 'danger-full-access' });
    expect(prompt.reason).toBe('Allow one call to use danger-full-access: Write the requested file');
    await expectMissing(workspace);
    expect(broker.respond(workspace, 'session', prompt.requestId, 'allow')).toBe(true);
    const events = await remaining(stream);
    expect(events.find((event) => event.type === 'tool.result')).toMatchObject({ result: { ok: true } });
    expect(await readFile(join(workspace, 'approval.txt'), 'utf8')).toBe('private-argument');
    expect(session.dshPermissions).toEqual(snapshot('workspace-write'));
  });

  it('denies on timeout and rejects late responses', async () => {
    vi.useFakeTimers();
    const broker = new ApprovalBroker({ timeoutMs: 100 });
    const turn = broker.start('/a', 's');
    const result = broker.handler('/a', 's')!(request, new AbortController().signal);
    const source = (async function* (): AsyncGenerator<AgentEvent> { await result; })();
    const stream = turn.stream(source);
    const prompt = (await nextRequest(stream)).prompt;
    expect(prompt.reason).toBe('Tool execution requires approval');
    expect(JSON.stringify(prompt)).not.toContain('private-raw');
    expect(JSON.stringify(prompt)).not.toContain('private-rule');
    expect(JSON.stringify(prompt)).not.toContain('/private');
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe('deny');
    expect(broker.respond('/a', 's', prompt.requestId, 'allow')).toBe(false);
    await remaining(stream);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles pending approval on interrupt and prevents a stale allow in the next turn', async () => {
    const broker = new ApprovalBroker();
    const workspace = await temporaryRoot();
    const f = await fixture(broker, workspace, 'session');
    const prompt = (await nextRequest(f.stream)).prompt;
    f.session.interrupt();
    const events = await remaining(f.stream);
    expect(events.at(-1)).toEqual({ type: 'turn.end', reason: 'interrupted' });
    expect(broker.respond(workspace, 'session', prompt.requestId, 'allow')).toBe(false);
    await expectMissing(workspace);
    const next = broker.start(workspace, 'session');
    expect((await remaining(next.stream(f.session.send('next')))).at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
  });

  it('denies and releases a pending request when the SSE consumer closes', async () => {
    const broker = new ApprovalBroker();
    const workspace = await temporaryRoot();
    const f = await fixture(broker, workspace, 'session');
    const prompt = (await nextRequest(f.stream)).prompt;
    f.session.interrupt();
    f.turn.close();
    await f.stream.return(undefined);
    expect(broker.respond(workspace, 'session', prompt.requestId, 'allow')).toBe(false);
    await expectMissing(workspace);
    const next = broker.start(workspace, 'session');
    expect((await remaining(next.stream(f.session.send('next')))).at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
  });

  it('does not pull source events ahead of the downstream consumer', async () => {
    const broker = new ApprovalBroker();
    const turn = broker.start('/a', 's');
    const requested: number[] = [];
    const source = (async function* (): AsyncGenerator<AgentEvent> {
      requested.push(1);
      yield { type: 'turn.start', step: 1 };
      requested.push(2);
      yield { type: 'turn.end', reason: 'end_turn' };
    })();
    const stream = turn.stream(source);
    expect((await stream.next()).value).toEqual({ type: 'turn.start', step: 1 });
    expect(requested).toEqual([1]);
    expect((await stream.next()).value).toEqual({ type: 'turn.end', reason: 'end_turn' });
    expect(requested).toEqual([1, 2]);
    await stream.next();
  });

  it('invalidates a pending request when its source ends while the consumer is paused', async () => {
    const broker = new ApprovalBroker();
    const turn = broker.start('/a', 's');
    let approval!: Promise<'allow' | 'deny'>;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const source = (async function* (): AsyncGenerator<AgentEvent> {
      approval = broker.handler('/a', 's')!(request, new AbortController().signal);
      await gate;
    })();
    const stream = turn.stream(source);
    const prompt = (await nextRequest(stream)).prompt;
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(broker.respond('/a', 's', prompt.requestId, 'allow')).toBe(false);
      expect(await approval).toBe('deny');
    } finally {
      turn.close();
      await stream.return(undefined);
    }
  });

  it('cleans up a pending request if the source fails', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 100 });
    const turn = broker.start('/a', 's');
    let approval!: Promise<'allow' | 'deny'>;
    let fail!: () => void;
    const gate = new Promise<void>((resolve) => { fail = resolve; });
    const source = (async function* (): AsyncGenerator<AgentEvent> {
      approval = broker.handler('/a', 's')!(request, new AbortController().signal);
      await gate;
      throw new Error('source failed');
    })();
    const stream = turn.stream(source);
    const prompt = (await nextRequest(stream)).prompt;
    fail();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await approval).toBe('deny');
    await expect(stream.next()).rejects.toThrow('source failed');
    expect(broker.respond('/a', 's', prompt.requestId, 'allow')).toBe(false);
    broker.start('/a', 's').close();
  });

  it('does not execute when interruption races an accepted response', async () => {
    const broker = new ApprovalBroker();
    const workspace = await temporaryRoot();
    const f = await fixture(broker, workspace, 'session');
    const prompt = (await nextRequest(f.stream)).prompt;
    expect(broker.respond(workspace, 'session', prompt.requestId, 'allow')).toBe(true);
    f.session.interrupt();
    f.turn.close();
    await f.stream.return(undefined);
    await expectMissing(workspace);
    expect(broker.respond(workspace, 'session', prompt.requestId, 'allow')).toBe(false);
  });

  it('uses the cached session handler for approvals in later turns', async () => {
    const broker = new ApprovalBroker();
    const workspace = await temporaryRoot();
    const store = new SessionStore(await temporaryRoot());
    const handle = await store.create({ id: 's', workspace, cwd: workspace });
    const call = writeCall('same');
    const session = new Session({
      cwd: workspace, session: handle, dshPermissions: snapshot('read-only'),
      model: new FakeModel([toolCallResponse([call]), textResponse('first'), toolCallResponse([call]), textResponse('second')]),
      approve: broker.handler(workspace, 's'),
    });
    const first = broker.start(workspace, 's').stream(session.send('first'));
    const firstPrompt = (await nextRequest(first)).prompt;
    expect(broker.respond(workspace, 's', firstPrompt.requestId, 'deny')).toBe(true);
    await remaining(first);
    await expectMissing(workspace);
    const second = broker.start(workspace, 's').stream(session.send('second'));
    const secondPrompt = (await nextRequest(second)).prompt;
    expect(secondPrompt.requestId).not.toBe(firstPrompt.requestId);
    expect(broker.respond(workspace, 's', firstPrompt.requestId, 'allow')).toBe(false);
    expect(broker.respond(workspace, 's', secondPrompt.requestId, 'allow')).toBe(true);
    await remaining(second);
    expect(await readFile(join(workspace, 'approval.txt'), 'utf8')).toBe('private-argument');
  });

  it('defaults to deny without an active turn, for a second pending request, and on serialization failure', async () => {
    const broker = new ApprovalBroker();
    const handler = broker.handler('/a', 's')!;
    expect(await handler(request, new AbortController().signal)).toBe('deny');
    const turn = broker.start('/a', 's');
    const first = handler(request, new AbortController().signal);
    expect(await handler(request, new AbortController().signal)).toBe('deny');
    turn.close();
    expect(await first).toBe('deny');
    const next = broker.start('/a', 's');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(await handler({ ...request, call: { ...request.call, arguments: circular } }, new AbortController().signal)).toBe('deny');
    next.close();
  });
});
