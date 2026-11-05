import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Tool } from './domain/tool';
import {
  createInitialDshPermissionEvent,
  projectDshPermissions,
  snapshotDshPermissions,
} from './permissions/dsh-permissions';
import type { DshPermissionPreset, DshPermissionSnapshot } from './permissions/dsh-permissions';
import type { AgentEvent } from './protocol/events';
import { FakeModel, textResponse, toolCallResponse } from './providers/fake';
import { Session } from './session';
import { SessionStore } from './session/store';
import { ToolRegistry } from './tools/registry';

const snapshot = (preset: DshPermissionPreset) =>
  snapshotDshPermissions(projectDshPermissions([createInitialDshPermissionEvent(preset)]));

async function collect(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

function decisions(events: AgentEvent[]) {
  return events.filter((event) => event.type === 'permission.decided')
    .map((event) => ({ callId: event.callId, decision: event.decision }));
}

function model(calls: Array<{ id: string; name: string; args: unknown }>) {
  return new FakeModel([toolCallResponse(calls), textResponse('done')]);
}

async function workspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'omniagent-session-dsh-')));
}

describe('Session DSH permissions', () => {
  it('denies legacy bypass and allow rules when there is no DSH snapshot', async () => {
    const execute = vi.fn(async () => ({ content: 'executed' }));
    const tool: Tool = { name: 'example', description: '', parameters: z.object({}), mutating: true, execute };
    const approve = vi.fn(async () => 'allow' as const);
    const session = new Session({
      cwd: process.cwd(), model: model([{ id: 'c1', name: 'example', args: {} }]),
      tools: new ToolRegistry().register(tool), mode: 'bypass',
      rules: [{ raw: '*', tool: '*', decision: 'allow', source: 'managed', anchor: process.cwd() }], approve,
    });
    expect(decisions(await collect(session.send('go')))).toEqual([{ callId: 'c1', decision: 'deny' }]);
    expect(execute).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  it('denies unrecognized custom tools in confined modes even when their metadata claims they are non-mutating', async () => {
    const execute = vi.fn(async () => ({ content: 'executed' }));
    const tool: Tool = { name: 'example', description: '', parameters: z.object({}), mutating: false, execute };
    const approve = vi.fn(async () => 'allow' as const);
    const session = new Session({
      cwd: process.cwd(), dshPermissions: snapshot('workspace-write'),
      model: model([{ id: 'c1', name: 'example', args: {} }]), tools: new ToolRegistry().register(tool), approve,
    });
    expect(decisions(await collect(session.send('go')))).toEqual([{ callId: 'c1', decision: 'deny' }]);
    expect(execute).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  it('runs ordinary full-access calls without asking but denies explicit approval requests', async () => {
    const execute = vi.fn(async () => ({ content: 'executed' }));
    const tool: Tool = { name: 'example', description: '', parameters: z.object({}), mutating: true, execute };
    const approve = vi.fn(async () => 'allow' as const);
    const session = new Session({
      cwd: process.cwd(), dshPermissions: snapshot('danger-full-access'), tools: new ToolRegistry().register(tool), approve,
      model: model([
        { id: 'ordinary', name: 'example', args: {} },
        { id: 'request', name: 'example', args: { sandbox_permissions: 'danger-full-access', justification: 'Please approve' } },
      ]),
    });
    expect(decisions(await collect(session.send('go')))).toEqual([
      { callId: 'ordinary', decision: 'allow' }, { callId: 'request', decision: 'deny' },
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(approve).not.toHaveBeenCalled();
  });

  it('rejects malformed, incomplete, equal and narrower escalation requests without approval', async () => {
    const root = await workspace();
    try {
      const approve = vi.fn(async () => 'allow' as const);
      const calls = [
        { id: 'missing-reason', name: 'write_file', args: { path: 'a', content: '', sandbox_permissions: 'danger-full-access' } },
        { id: 'blank-reason', name: 'write_file', args: { path: 'b', content: '', sandbox_permissions: 'danger-full-access', justification: ' ' } },
        { id: 'bad-target', name: 'write_file', args: { path: 'c', content: '', sandbox_permissions: 'bypass', justification: 'reason' } },
        { id: 'reason-only', name: 'write_file', args: { path: 'd', content: '', justification: 'reason' } },
        { id: 'same', name: 'write_file', args: { path: 'e', content: '', sandbox_permissions: 'workspace-write', justification: 'reason' } },
        { id: 'narrow', name: 'write_file', args: { path: 'f', content: '', sandbox_permissions: 'read-only', justification: 'reason' } },
      ];
      const session = new Session({ cwd: root, dshPermissions: snapshot('workspace-write'), model: model(calls), approve });
      expect(decisions(await collect(session.send('go')))).toEqual(calls.map(({ id }) => ({ callId: id, decision: 'deny' })));
      expect(approve).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('requires a fresh approval for each wider call and strips escalation fields before a fenced write', async () => {
    const root = await workspace();
    try {
      const approve = vi.fn(async () => 'allow' as const);
      const call = (id: string, path: string) => ({ id, name: 'write_file', args: {
        path, content: id, sandbox_permissions: 'workspace-write', justification: 'Write a requested file',
      } });
      const session = new Session({
        cwd: root, dshPermissions: snapshot('read-only'), approve,
        model: model([call('first', 'a'), { id: 'normal', name: 'write_file', args: { path: 'b', content: 'no' } }, call('second', 'c')]),
      });
      const events = await collect(session.send('go'));
      expect(approve).toHaveBeenCalledTimes(2);
      expect(await readFile(join(root, 'a'), 'utf8')).toBe('first');
      expect(await readFile(join(root, 'c'), 'utf8')).toBe('second');
      await expect(readFile(join(root, 'b'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(events.filter((event) => event.type === 'tool.result').map((event) => event.result.ok)).toEqual([true, false, true]);
      expect(session.dshPermissions).toEqual(snapshot('read-only'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('exposes the write escalation fields to the model', async () => {
    const root = await workspace();
    try {
      const fake = new FakeModel([textResponse('done')]);
      const session = new Session({ cwd: root, model: fake, dshPermissions: snapshot('read-only') });
      await collect(session.send('go'));
      const spec = fake.requests[0]?.tools.find((tool) => tool.name === 'write_file');
      expect(spec?.parameters).toMatchObject({
        properties: { sandbox_permissions: expect.any(Object), justification: expect.any(Object) },
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('executes the approved arguments even if the approval callback mutates its request', async () => {
    const root = await workspace();
    try {
      const session = new Session({
        cwd: root, dshPermissions: snapshot('read-only'),
        model: model([{ id: 'write', name: 'write_file', args: {
          path: 'approved', content: 'original',
          sandbox_permissions: 'workspace-write', justification: 'Write the file',
        } }]),
        approve: async (request) => {
          Object.assign(request.call.arguments as Record<string, unknown>, { path: 'changed', content: 'changed' });
          return 'allow';
        },
      });
      const events = await collect(session.send('go'));
      expect(events.find((event) => event.type === 'tool.result')).toMatchObject({ result: { ok: true } });
      expect(await readFile(join(root, 'approved'), 'utf8')).toBe('original');
      await expect(readFile(join(root, 'changed'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('registers and executes bash using the trusted full-access policy', async () => {
    const root = await workspace();
    try {
      const approve = vi.fn(async () => 'deny' as const);
      const fake = model([{ id: 'bash', name: 'bash', args: { command: 'printf dsh-shell-ok' } }]);
      const session = new Session({ cwd: root, model: fake, dshPermissions: snapshot('danger-full-access'), approve });
      const events = await collect(session.send('go'));
      expect(fake.requests[0]?.tools).toContainEqual(expect.objectContaining({ name: 'bash' }));
      expect(events.find((event) => event.type === 'tool.result')).toMatchObject({
        result: { callId: 'bash', ok: true, content: expect.stringContaining('dsh-shell-ok') },
      });
      expect(approve).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('captures a frozen snapshot at construction and keeps it throughout a multi-call turn', async () => {
    const supplied = { ...snapshot('danger-full-access') };
    const execute = vi.fn(async () => ({ content: 'executed' }));
    const tool: Tool = { name: 'example', description: '', parameters: z.object({}), mutating: true, execute };
    const session = new Session({
      cwd: process.cwd(), dshPermissions: supplied, tools: new ToolRegistry().register(tool),
      model: model([{ id: 'first', name: 'example', args: {} }, { id: 'second', name: 'example', args: {} }]),
    });
    expect(session.dshPermissions).toEqual(snapshot('danger-full-access'));
    expect(session.dshPermissions).not.toBe(supplied);
    expect(Object.isFrozen(session.dshPermissions)).toBe(true);
    const events: AgentEvent[] = [];
    for await (const event of session.send('go')) {
      events.push(event);
      if (event.type === 'tool.result') Object.assign(supplied, snapshot('read-only'));
    }
    expect(decisions(events)).toEqual([
      { callId: 'first', decision: 'allow' }, { callId: 'second', decision: 'allow' },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(session.dshPermissions).toEqual(snapshot('danger-full-access'));
  });

  it('does not let a later options mutation widen the workspace policy', async () => {
    const root = await workspace();
    const outside = await realpath(await mkdtemp(join('/var/tmp', 'omniagent-dsh-outside-')));
    try {
      const target = join(outside, 'blocked');
      const options = {
        cwd: root,
        dshPermissions: snapshot('workspace-write'),
        model: model([{ id: 'write', name: 'write_file', args: { path: target, content: 'no' } }]),
      };
      const session = new Session(options);
      options.cwd = outside;
      const events = await collect(session.send('go'));
      expect(events.find((event) => event.type === 'tool.result')).toMatchObject({ result: { ok: false } });
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
    }
  });

  it('does not allow runtime reassignment of the session permission snapshot', async () => {
    const root = await workspace();
    try {
      const session = new Session({
        cwd: root, dshPermissions: snapshot('read-only'),
        model: model([{ id: 'write', name: 'write_file', args: { path: 'blocked', content: 'no' } }]),
      });
      try {
        (session as unknown as { dshPermissions: DshPermissionSnapshot }).dshPermissions = snapshot('danger-full-access');
      } catch { /* Assignment to a getter-only property is rejected in strict mode. */ }
      const events = await collect(session.send('go'));
      expect(session.dshPermissions).toEqual(snapshot('read-only'));
      expect(events.find((event) => event.type === 'tool.result')).toMatchObject({ result: { ok: false } });
      await expect(readFile(join(root, 'blocked'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects invalid snapshots instead of mapping legacy modes or trusting mismatched bundles', () => {
    for (const invalid of [
      { preset: 'bypass', sandbox: 'danger-full-access', approval: 'never' },
      { preset: 'read-only', sandbox: 'danger-full-access', approval: 'never' },
      { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'never' },
      null,
    ]) {
      expect(() => new Session({
        cwd: process.cwd(), model: new FakeModel([]), dshPermissions: invalid as DshPermissionSnapshot,
      })).toThrow(/DSH permission/i);
    }
  });

  it('does not append a DSH preset event during construction or a turn', async () => {
    const root = await workspace();
    try {
      const handle = await new SessionStore(root).create({ id: 'session', workspace: root, cwd: root });
      const session = new Session({
        cwd: root, dshPermissions: snapshot('workspace-write'), model: new FakeModel([textResponse('done')]), session: handle,
      });
      expect(handle.events).toEqual([]);
      await collect(session.send('go'));
      expect(handle.events.some((event) => event.type === 'permission/dsh-preset')).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
