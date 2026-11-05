import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './protocol/events';
import {
  createInitialDshPermissionEvent,
  isDshPermissionPreset,
  projectDshPermissions,
  snapshotDshPermissions,
} from './permissions/dsh-permissions';
import type { DshPermissionPreset } from './permissions/dsh-permissions';
import { FakeModel, textResponse, toolCallResponse } from './providers/fake';
import { Session } from './session';
import type { SessionOptions } from './session';

let workspace: string;
let outside: string;

beforeEach(async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-dsh-runtime-'));
  const external = await mkdtemp(join('/var/tmp', 'omniagent-dsh-outside-'));
  onTestFinished(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(external, { recursive: true, force: true }),
    ]);
  });
  workspace = join(root, 'workspace');
  outside = external;
  await mkdir(workspace);
});

function sessionWith(
  model: FakeModel,
  preset: DshPermissionPreset | string,
  approve: SessionOptions['approve'],
): Session {
  const dshPermissions = isDshPermissionPreset(preset)
    ? snapshotDshPermissions(projectDshPermissions([createInitialDshPermissionEvent(preset)]))
    : { preset, sandbox: preset, approval: 'ask' } as never;
  return new Session({ cwd: workspace, model, dshPermissions, approve });
}

async function collect(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

function resultsOf(events: AgentEvent[]) {
  return events.flatMap((event) => event.type === 'tool.result' ? [event.result] : []);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('DSH permissions through Session and AgentLoop', () => {
  it('denies read-only built-in writes without changing existing files or creating parents', async () => {
    await writeFile(join(workspace, 'existing.txt'), 'original');
    const approve = vi.fn(async () => 'allow' as const);
    const model = new FakeModel([
      toolCallResponse([
        { id: 'overwrite', name: 'write_file', args: { path: 'existing.txt', content: 'changed' } },
        { id: 'create', name: 'write_file', args: { path: 'new-dir/file.txt', content: 'new' } },
      ]),
      textResponse('Could not write.'),
    ]);

    const events = await collect(sessionWith(model, 'read-only', approve).send('write files'));

    expect(await readFile(join(workspace, 'existing.txt'), 'utf8')).toBe('original');
    expect(existsSync(join(workspace, 'new-dir'))).toBe(false);
    expect(resultsOf(events)).toMatchObject([
      { callId: 'overwrite', name: 'write_file', ok: false },
      { callId: 'create', name: 'write_file', ok: false },
    ]);
    expect(approve).not.toHaveBeenCalled();
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      results: [{ callId: 'overwrite', ok: false }, { callId: 'create', ok: false }],
    });
    expect(events.at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
  });

  it('writes inside the workspace without soliciting approval and returns the result to the model', async () => {
    const approve = vi.fn(async () => 'deny' as const);
    const model = new FakeModel([
      toolCallResponse([{ id: 'inside', name: 'write_file', args: { path: 'nested/file.txt', content: 'inside' } }]),
      textResponse('Written.'),
    ]);

    const events = await collect(sessionWith(model, 'workspace-write', approve).send('write inside'));

    expect(approve).not.toHaveBeenCalled();
    expect(resultsOf(events)).toMatchObject([{ callId: 'inside', name: 'write_file', ok: true }]);
    expect(await readFile(join(workspace, 'nested/file.txt'), 'utf8')).toBe('inside');
    expect(model.requests[0]?.tools).toContainEqual(expect.objectContaining({ name: 'write_file' }));
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool', results: [{ callId: 'inside', name: 'write_file', ok: true }],
    });
    expect(events.at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
  });

  it('denies workspace symlink escapes before overwriting or creating outside files', async () => {
    await writeFile(join(outside, 'existing.txt'), 'outside original');
    await symlink(outside, join(workspace, 'link'), 'dir');
    const approve = vi.fn(async () => 'allow' as const);
    const model = new FakeModel([
      toolCallResponse([
        { id: 'outside-existing', name: 'write_file', args: { path: 'link/existing.txt', content: 'changed' } },
        { id: 'outside-new', name: 'write_file', args: { path: 'link/new-dir/file.txt', content: 'new' } },
      ]),
      textResponse('Could not escape.'),
    ]);

    const events = await collect(sessionWith(model, 'workspace-write', approve).send('write through link'));

    expect(await readFile(join(outside, 'existing.txt'), 'utf8')).toBe('outside original');
    expect(existsSync(join(outside, 'new-dir'))).toBe(false);
    expect(resultsOf(events)).toMatchObject([
      { callId: 'outside-existing', ok: false },
      { callId: 'outside-new', ok: false },
    ]);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool', results: [{ callId: 'outside-existing', ok: false }, { callId: 'outside-new', ok: false }],
    });
  });

  it('allows danger-full-access to write outside the workspace without approval', async () => {
    const target = join(outside, 'full-access.txt');
    const approve = vi.fn(async () => 'deny' as const);
    const model = new FakeModel([
      toolCallResponse([{ id: 'full', name: 'write_file', args: { path: target, content: 'allowed' } }]),
      textResponse('Written.'),
    ]);

    const events = await collect(sessionWith(model, 'danger-full-access', approve).send('write outside'));

    expect(approve).not.toHaveBeenCalled();
    expect(resultsOf(events)).toMatchObject([{ callId: 'full', ok: true }]);
    expect(await readFile(target, 'utf8')).toBe('allowed');
  });

  it('approves an explicit wider retry for one call without changing the standing policy', async () => {
    const approve = vi.fn<NonNullable<SessionOptions['approve']>>(async () => 'allow');
    const model = new FakeModel([
      toolCallResponse([{ id: 'initial', name: 'write_file', args: { path: 'approved.txt', content: 'approved' } }]),
      toolCallResponse([{ id: 'retry', name: 'write_file', args: {
        path: 'approved.txt', content: 'approved',
        sandbox_permissions: 'workspace-write', justification: 'Write the requested workspace file.',
      } }]),
      toolCallResponse([{ id: 'later', name: 'write_file', args: { path: 'later.txt', content: 'not approved' } }]),
      textResponse('Finished.'),
    ]);

    const events = await collect(sessionWith(model, 'read-only', approve).send('write the requested file'));

    expect(resultsOf(events)).toMatchObject([
      { callId: 'initial', ok: false },
      { callId: 'retry', ok: true },
      { callId: 'later', ok: false },
    ]);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]?.[0]).toMatchObject({ call: { id: 'retry', name: 'write_file' } });
    expect(await readFile(join(workspace, 'approved.txt'), 'utf8')).toBe('approved');
    expect(existsSync(join(workspace, 'later.txt'))).toBe(false);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', results: [{ callId: 'initial', ok: false }] });
    expect(model.requests[2]?.messages.at(-1)).toMatchObject({ role: 'tool', results: [{ callId: 'retry', ok: true }] });
    expect(model.requests[3]?.messages.at(-1)).toMatchObject({ role: 'tool', results: [{ callId: 'later', ok: false }] });
  });

  it('does not write when an explicit escalation is rejected', async () => {
    const approve = vi.fn(async () => 'deny' as const);
    const model = new FakeModel([
      toolCallResponse([{ id: 'rejected', name: 'write_file', args: {
        path: 'rejected.txt', content: 'must not exist',
        sandbox_permissions: 'workspace-write', justification: 'Write the requested workspace file.',
      } }]),
      textResponse('Not approved.'),
    ]);

    const events = await collect(sessionWith(model, 'read-only', approve).send('write'));

    expect(approve).toHaveBeenCalledTimes(1);
    expect(existsSync(join(workspace, 'rejected.txt'))).toBe(false);
    expect(resultsOf(events)).toMatchObject([{ callId: 'rejected', ok: false }]);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', results: [{ callId: 'rejected', ok: false }] });
  });

  it.each(['bypass', 'default', 'acceptEdits', 'dontAsk', 'plan', 'not-a-preset'])(
    'fails closed for unknown or legacy DSH permission %s',
    async (selection) => {
      const target = join(workspace, 'invalid-preset.txt');
      const approve = vi.fn(async () => 'allow' as const);
      const model = new FakeModel([
        toolCallResponse([{ id: 'invalid', name: 'write_file', args: { path: target, content: 'must not exist' } }]),
        textResponse('Finished.'),
      ]);

      const outcome = await Promise.resolve().then(async () => {
        const session = sessionWith(model, selection, approve);
        return collect(session.send('write'));
      }).then((events) => ({ kind: 'events' as const, events }), (error: unknown) => ({ kind: 'error' as const, error }));

      expect(existsSync(target)).toBe(false);
      expect(approve).not.toHaveBeenCalled();
      if (outcome.kind === 'error') {
        expect(outcome.error).toBeInstanceOf(Error);
        expect(String(outcome.error)).toMatch(/permission|preset|sandbox|unknown|invalid|unsupported/i);
      } else {
        expect(outcome.events.some((event) =>
          (event.type === 'tool.result' && !event.result.ok)
          || event.type === 'error'
          || (event.type === 'turn.end' && event.reason === 'error'),
        )).toBe(true);
      }
    },
  );

  it('does not execute or approve a tool call returned with max_tokens', async () => {
    const target = join(workspace, 'truncated.txt');
    const approve = vi.fn(async () => 'allow' as const);
    const model = new FakeModel([
      { ...toolCallResponse([{ id: 'truncated', name: 'write_file', args: { path: target, content: 'partial' } }]),
        stopReason: 'max_tokens' },
      textResponse('Must not be requested.'),
    ]);

    const events = await collect(sessionWith(model, 'danger-full-access', approve).send('write'));

    expect(existsSync(target)).toBe(false);
    expect(approve).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'tool.call' || event.type === 'tool.result')).toBe(false);
    expect(model.requests).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'turn.end', reason: 'max_tokens' });
  });

  it('interrupts before a workspace write at the tool-call event boundary', async () => {
    const approve = vi.fn(async () => 'allow' as const);
    const model = new FakeModel([
      toolCallResponse([{ id: 'cancelled', name: 'write_file', args: { path: 'cancelled.txt', content: 'no' } }]),
    ]);
    const session = sessionWith(model, 'workspace-write', approve);
    const turn = session.send('write');
    let event = await turn.next();
    while (!event.done && event.value.type !== 'tool.call') event = await turn.next();
    expect(event.value).toMatchObject({ type: 'tool.call', call: { id: 'cancelled' } });

    session.interrupt();
    const remaining = await collect(turn);

    expect(remaining.at(-1)).toEqual({ type: 'turn.end', reason: 'interrupted' });
    expect(approve).not.toHaveBeenCalled();
    expect(existsSync(join(workspace, 'cancelled.txt'))).toBe(false);
    expect(remaining.some((item) => item.type === 'tool.result')).toBe(false);
    expect(model.requests).toHaveLength(1);
  });

  it('cancels pending escalation, ignores a late grant, and repairs the next model request', async () => {
    const asked = deferred<AbortSignal>();
    const approval = deferred<'allow' | 'deny'>();
    const model = new FakeModel([
      toolCallResponse([{ id: 'pending', name: 'write_file', args: {
        path: 'pending.txt', content: 'must not exist',
        sandbox_permissions: 'workspace-write', justification: 'Write the requested workspace file.',
      } }]),
      textResponse('Continued.'),
    ]);
    const approve: SessionOptions['approve'] = async (_request, signal) => {
      asked.resolve(signal);
      return approval.promise;
    };
    const session = sessionWith(model, 'read-only', approve);
    const turn = collect(session.send('write'));

    try {
      const first = await Promise.race([
        asked.promise.then((signal) => ({ kind: 'asked' as const, signal })),
        turn.then((events) => ({ kind: 'ended' as const, events })),
      ]);
      if (first.kind === 'ended') expect.fail('Escalation ended without asking for approval');
      expect(first.signal).toBeInstanceOf(AbortSignal);
      expect(first.signal.aborted).toBe(false);

      session.interrupt();
      expect((await turn).at(-1)).toEqual({ type: 'turn.end', reason: 'interrupted' });
      expect(first.signal.aborted).toBe(true);
      approval.resolve('allow');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(existsSync(join(workspace, 'pending.txt'))).toBe(false);

      const continuation = await collect(session.send('continue'));
      expect(continuation.at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
      expect(model.requests[1]?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
      expect(model.requests[1]?.messages[2]).toMatchObject({
        role: 'tool', results: [{ callId: 'pending', name: 'write_file', ok: false }],
      });
      expect(existsSync(join(workspace, 'pending.txt'))).toBe(false);
    } finally {
      session.interrupt();
      approval.resolve('deny');
    }
  }, 3000);
});
