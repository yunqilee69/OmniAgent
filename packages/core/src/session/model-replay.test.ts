import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MessageSchema } from '../domain/message';
import type { AssistantMessage, Message } from '../domain/message';
import { FakeModel, textResponse } from '../providers/fake';
import { replayEndpointHash } from '../providers/replay-identity';
import { Session } from '../session';
import * as projection from './projection';
import { sessionPath, SessionStore } from './store';
import type { SessionEvent } from './types';

const dshReplay = {
  kind: 'deepseek-messages',
  version: 1,
  provider: 'deepseek-official',
  model: 'deepseek-v4',
  endpoint: replayEndpointHash('https://api.deepseek.com/anthropic/v1/messages'),
  blocks: [
    { type: 'thinking', thinking: 'private dsh reasoning', signature: 'private dsh signature' },
    { type: 'text', text: 'Checking' },
    { type: 'tool_use', id: 'call-1', name: 'inspect', input: { path: 'file', nested: [true, null, 7] }, raw: '{"path":"file"}' },
  ],
};

const providerReplay = {
  kind: 'pi-ai',
  version: 1,
  provider: 'anthropic',
  model: 'claude-test',
  api: 'anthropic-messages',
  endpoint: replayEndpointHash('https://example.invalid/v1'),
  responseModel: 'claude-test-2026',
  responseId: 'response-1',
  providerThinkingLevel: 'high',
  stopReason: 'toolUse',
  content: [
    { type: 'thinking', thinking: 'private pi reasoning', thinkingSignature: 'private pi signature', redacted: true },
    { type: 'text', text: 'Checking', textSignature: 'private text signature' },
    { type: 'toolCall', id: 'call-1', name: 'inspect', arguments: { path: 'file', nested: [true, null, 7] },
      thoughtSignature: 'private thought signature', namespace: 'files' },
  ],
};

const assistant = {
  role: 'assistant',
  content: [{ type: 'text', text: 'Checking' }],
  toolCalls: [{ id: 'call-1', name: 'inspect', arguments: { path: 'file' }, raw: '{"path":"file"}' }],
  usage: { inputTokens: 2, outputTokens: 3 },
};

function storedAssistant(data: unknown, type = 'message/assistant'): SessionEvent {
  return { seq: 0, ts: 1, type, data };
}

describe('model replay persistence', () => {
  it('validates and preserves both ordered replay formats in the message schema', () => {
    const result = MessageSchema.safeParse({ ...assistant, dshReplay, providerReplay });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ ...assistant, dshReplay, providerReplay });
  });

  it.each(['message/assistant', 'assistant/message'])('projects valid replay from %s', (type) => {
    expect(projection.projectMessages([storedAssistant({ ...assistant, dshReplay, providerReplay }, type)]))
      .toEqual([{ ...assistant, dshReplay, providerReplay }]);
  });

  it.each([
    ['wrong kind', { ...dshReplay, kind: 'unknown' }],
    ['wrong version', { ...dshReplay, version: 2 }],
    ['wrong provider', { ...dshReplay, provider: 'other' }],
    ['empty model', { ...dshReplay, model: '' }],
    ['unknown block', { ...dshReplay, blocks: [{ type: 'unknown', thinking: 'do-not-forward' }] }],
    ['invalid signature', { ...dshReplay, blocks: [{ type: 'thinking', thinking: 'private', signature: 12 }] }],
    ['non-object input', { ...dshReplay, blocks: [{ type: 'tool_use', id: 'x', name: 'inspect', input: [], raw: '{}' }] }],
    ['non-JSON input', { ...dshReplay, blocks: [{ type: 'tool_use', id: 'x', name: 'inspect', input: { value: Infinity }, raw: '{}' }] }],
    ['unrecognized field', { ...dshReplay, secret: 'do-not-forward' }],
    ['too many blocks', { ...dshReplay, blocks: Array.from({ length: 1025 }, () => ({ type: 'text', text: '' })) }],
    ['oversized model', { ...dshReplay, model: 'x'.repeat(1025) }],
  ])('drops invalid dsh replay (%s) without losing the assistant or valid pi replay', (_label, invalid) => {
    const event = storedAssistant({ ...assistant, dshReplay: invalid, providerReplay });
    expect(MessageSchema.safeParse(event.data).success).toBe(false);
    expect(projection.projectMessages([event])).toEqual([{ ...assistant, providerReplay }]);
  });

  it.each([
    ['wrong version', { ...providerReplay, version: 2 }],
    ['wrong kind', { ...providerReplay, kind: 'other' }],
    ['missing provenance', { ...providerReplay, provider: '' }],
    ['unknown block', { ...providerReplay, content: [{ type: 'image', data: 'do-not-forward' }] }],
    ['invalid redaction flag', { ...providerReplay, content: [{ type: 'thinking', thinking: 'private', redacted: 'yes' }] }],
    ['invalid arguments', { ...providerReplay, content: [{ type: 'toolCall', id: 'x', name: 'inspect', arguments: [] }] }],
    ['non-JSON arguments', { ...providerReplay, content: [{ type: 'toolCall', id: 'x', name: 'inspect', arguments: { value: undefined } }] }],
    ['unexpected credentials', { ...providerReplay, headers: { authorization: 'do-not-forward' } }],
    ['unexpected block field', { ...providerReplay, content: [{ type: 'text', text: 'safe', secret: 'do-not-forward' }] }],
    ['untrusted argument diagnostics', { ...providerReplay, content: [{ type: 'toolCall', id: 'x', name: 'inspect', arguments: {}, argumentsError: 'do-not-forward' }] }],
    ['invalid stop reason', { ...providerReplay, stopReason: 'not-valid' }],
    ['oversized response id', { ...providerReplay, responseId: 'x'.repeat(1025) }],
    ['too many blocks', { ...providerReplay, content: Array.from({ length: 1025 }, () => ({ type: 'text', text: '' })) }],
  ])('drops invalid pi replay (%s) without losing the assistant or valid dsh replay', (_label, invalid) => {
    const event = storedAssistant({ ...assistant, dshReplay, providerReplay: invalid });
    expect(MessageSchema.safeParse(event.data).success).toBe(false);
    expect(projection.projectMessages([event])).toEqual([{ ...assistant, dshReplay }]);
  });

  it('drops both invalid extensions without accepting an invalid base assistant', () => {
    expect(projection.projectMessages([
      storedAssistant({ ...assistant, dshReplay: null, providerReplay: {} }),
      storedAssistant({ ...assistant, content: 'invalid', dshReplay }),
      storedAssistant({ ...assistant, role: 'user', dshReplay }),
    ])).toEqual([assistant]);
  });

  it('persists live assistant replay and supplies it after a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-live-replay-'));
    try {
      const handle = await new SessionStore(root).create({ id: 'agent', workspace: root, cwd: root });
      const liveMessage = MessageSchema.parse({
        role: 'assistant', content: [{ type: 'text', text: 'Checking' }], toolCalls: [], dshReplay, providerReplay,
      }) as AssistantMessage;
      const first = new Session({
        cwd: root, model: new FakeModel([{ message: liveMessage }]), approve: async () => 'deny', session: handle,
      });
      for await (const _event of first.send('Start')) { /* Drain the turn. */ }
      await handle.close();

      const disk = await readFile(sessionPath(root, root, 'agent'), 'utf8');
      const events = disk.trim().split('\n').slice(1).map((line) => JSON.parse(line));
      expect(events.find((event) => event.type === 'message/assistant')?.data).toEqual(liveMessage);

      const reopened = await new SessionStore(root).open(root, 'agent');
      const model = new FakeModel([textResponse('continued')]);
      const resumed = new Session({ cwd: root, model, approve: async () => 'deny', session: reopened });
      for await (const _event of resumed.send('Continue')) { /* Drain the turn. */ }
      expect(model.requests[0]?.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Start' }] },
        liveMessage,
        { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes malformed persisted replay before supplying model history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-invalid-replay-'));
    try {
      const handle = await new SessionStore(root).create({ id: 'agent', workspace: root, cwd: root });
      const base = { role: 'assistant', content: [{ type: 'text', text: 'visible' }], toolCalls: [] };
      await handle.append({ type: 'message/assistant', data: {
        ...base, dshReplay: { ...dshReplay, version: 9 }, providerReplay: { ...providerReplay, api: 42 },
      } });
      await handle.close();

      const reopened = await new SessionStore(root).open(root, 'agent');
      const model = new FakeModel([textResponse('continued')]);
      const session = new Session({ cwd: root, model, approve: async () => 'deny', session: reopened });
      for await (const _event of session.send('Continue')) { /* Drain the turn. */ }
      expect(model.requests[0]?.messages).toEqual([
        base,
        { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('saves replay on disk and restores it to the resumed model request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-model-replay-'));
    try {
      const handle = await new SessionStore(root).create({ id: 'agent', workspace: root, cwd: root });
      await handle.append({ type: 'message/assistant', data: { ...assistant, dshReplay, providerReplay } });
      await handle.append({ type: 'message/tool-result', data: { result: {
        callId: 'call-1', name: 'inspect', ok: true, content: 'done', truncated: false,
      } } });
      await handle.close();

      const disk = await readFile(sessionPath(root, root, 'agent'), 'utf8');
      const stored = JSON.parse(disk.split('\n')[1]!);
      expect(stored.data).toEqual({ ...assistant, dshReplay, providerReplay });

      const reopened = await new SessionStore(root).open(root, 'agent');
      const model = new FakeModel([textResponse('continued')]);
      const session = new Session({ cwd: root, model, approve: async () => 'deny', session: reopened });
      for await (const _event of session.send('Continue')) { /* Drain the turn. */ }

      expect(model.requests[0]?.messages).toEqual([
        { ...assistant, dshReplay, providerReplay },
        { role: 'tool', results: [{ callId: 'call-1', name: 'inspect', ok: true, content: 'done', truncated: false }] },
        { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('safePublicMessages', () => {
  it('exposes only public message fields, stripping all replay and future private extensions', () => {
    const sanitize: unknown = Reflect.get(projection, 'safePublicMessages');
    expect(sanitize).toEqual(expect.any(Function));
    if (typeof sanitize !== 'function') return;

    const input = [
      { role: 'system', content: 'system', futureReplay: 'private system replay' },
      { role: 'user', content: [{ type: 'text', text: 'hello', privateData: 'private content' }], futureReplay: 'private user replay' },
      { ...assistant, dshReplay, providerReplay, futureReplay: { reasoning: 'private future reasoning' },
        toolCalls: [{ ...assistant.toolCalls[0], thoughtSignature: 'private call signature' }] },
      { role: 'tool', results: [{ callId: 'call-1', name: 'inspect', ok: true, content: 'done', truncated: false,
        privateData: 'private tool metadata' }], futureReplay: 'private tool replay' },
    ] as unknown as Message[];
    const original = structuredClone(input);
    const output = sanitize(input) as unknown;

    expect(output).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      assistant,
      { role: 'tool', results: [{ callId: 'call-1', name: 'inspect', ok: true, content: 'done', truncated: false }] },
    ]);
    expect(JSON.stringify(output)).not.toContain('private');
    expect(input).toEqual(original);
  });
});
