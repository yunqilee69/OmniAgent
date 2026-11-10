import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MessageSchema } from '../domain/message';
import { FakeModel, textResponse } from '../providers/fake';
import { Session } from '../session';
import { SessionStore } from './store';
import type { SessionEvent } from './types';
import { projectMessages, projectPublicHistory } from './projection';

describe('projectMessages', () => {
  it('restores and publishes valid cache reads without losing malformed or legacy usage', () => {
    const base = { role: 'assistant', content: [], toolCalls: [] };
    const events: SessionEvent[] = [
      { seq: 0, ts: 1, type: 'message/assistant', data: { ...base, usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 } } },
      { seq: 1, ts: 2, type: 'assistant/message', data: { ...base, usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 11 } } },
      { seq: 2, ts: 3, type: 'message/assistant', data: { ...base, usage: { inputTokens: 10, outputTokens: 2 } } },
    ];
    const messages = projectMessages(events);
    expect(messages).toEqual([
      { ...base, usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 } },
      { ...base, usage: { inputTokens: 10, outputTokens: 2 } },
      { ...base, usage: { inputTokens: 10, outputTokens: 2 } },
    ]);
    expect(projectPublicHistory('test', events)[0]).toMatchObject({ usage: { cachedInputTokens: 0 } });
  });

  it('restores and publishes request duration while preserving legacy and malformed messages', () => {
    const base = { role: 'assistant', content: [], toolCalls: [] };
    const events: SessionEvent[] = [
      { seq: 0, ts: 1, type: 'message/assistant', data: { ...base, requestDurationMs: 25.5 } },
      { seq: 1, ts: 2, type: 'assistant/message', data: base },
      { seq: 2, ts: 3, type: 'message/assistant', data: { ...base, requestDurationMs: -1 } },
    ];
    expect(projectMessages(events)).toEqual([{ ...base, requestDurationMs: 25.5 }, base, base]);
    const publicHistory = projectPublicHistory('test', events);
    expect(publicHistory[0]).toMatchObject({ ...base, requestDurationMs: 25.5 });
    expect(publicHistory[1]).not.toHaveProperty('requestDurationMs');
    expect(publicHistory[2]).not.toHaveProperty('requestDurationMs');
  });
  it('projects stable session-scoped identities and persisted timestamps without replay data', () => {
    const events: SessionEvent[] = [
      { seq: 0, ts: 100, type: 'message/user', data: { text: 'hello' } },
      { seq: 1, ts: 110, type: 'message/assistant', data: { role: 'assistant', content: [], toolCalls: [], providerReplay: { secret: true } } },
      { seq: 2, ts: 120, type: 'tool/result', data: { callId: 'a', name: 'tool', ok: true, content: 'one' } },
      { seq: 3, ts: 130, type: 'tool/result', data: { callId: 'b', name: 'tool', ok: true, content: 'two' } },
      { seq: 4, ts: 140, type: 'message/notice', data: { text: 'notice' } },
    ];
    const history = projectPublicHistory('session-a', events);
    expect(history.map((message) => message.timestamp)).toEqual([100, 110, 120, 140]);
    expect(history[2]).toMatchObject({ role: 'tool', results: [{ callId: 'a' }, { callId: 'b' }] });
    expect(JSON.stringify(history)).not.toContain('providerReplay');
    expect(projectPublicHistory('session-a', events)[0]?.messageId).toBe(history[0]?.messageId);
    expect(projectPublicHistory('session-b', events)[0]?.messageId).not.toBe(history[0]?.messageId);
  });
  it('persists structured file metadata without changing model text', () => {
    const part = { type: 'text', text: 'model-readable path', attachment: {
      kind: 'file', name: '笔记.txt', mediaType: 'text/plain', filePath: '.omniagent/attachments/batch/file',
      secret: 'not public',
    } };
    const events: SessionEvent[] = [{ seq: 0, ts: 1, type: 'message/user', data: { content: [part] } }];
    const expected = { type: 'text', text: part.text, attachment: {
      kind: 'file', name: '笔记.txt', mediaType: 'text/plain', filePath: part.attachment.filePath,
    } };
    expect(projectMessages(events)).toEqual([{ role: 'user', content: [expected] }]);
    expect(projectPublicHistory('session', events)[0]).toMatchObject({ role: 'user', content: [expected] });
  });

  it('retains image metadata in restored and public history', () => {
    const image = { type: 'image', mediaType: 'image/png', data: 'data', fileName: 'photo.png', filePath: '.images/photo.png' };
    const events: SessionEvent[] = [{ seq: 0, ts: 1, type: 'message/user', data: { content: [image] } }];
    expect(projectMessages(events)).toEqual([{ role: 'user', content: [image] }]);
    expect(projectPublicHistory('session', events)[0]).toMatchObject({ role: 'user', content: [image] });
  });

  it('restores stored user content arrays for current and legacy event names', () => {
    const events: SessionEvent[] = [
      {
        seq: 0,
        ts: 1,
        type: 'message/user',
        data: {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this image' },
            { type: 'image', mediaType: 'image/png', data: 'base64-image-data' },
          ],
          metadata: { requestId: 'request-1', secret: 'do-not-forward' },
          source: { kind: 'user', secret: 'do-not-forward-source' },
        },
      },
      {
        seq: 1,
        ts: 2,
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: 'Continue' }],
        },
      },
    ];

    expect(projectMessages(events)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read this image' },
          { type: 'image', mediaType: 'image/png', data: 'base64-image-data' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
    ]);
  });

  it('preserves valid parts of a malformed stored content array without admitting invalid parts', () => {
    const events: SessionEvent[] = [{
      seq: 0,
      ts: 1,
      type: 'message/user',
      data: { role: 'user', content: [
        { type: 'text', text: 'keep' }, null, { type: 'image', data: 'missing-media-type' },
        { type: 'image', mediaType: 'image/jpeg', data: 'keep-image' }, { type: 'text', text: 7 },
      ] },
    }];

    const messages = projectMessages(events);
    expect(messages).toEqual([{ role: 'user', content: [
      { type: 'text', text: 'keep' },
      { type: 'image', mediaType: 'image/jpeg', data: 'keep-image' },
    ] }]);
    expect(messages.every((message) => MessageSchema.safeParse(message).success)).toBe(true);
  });

  it('restores text and string content without forwarding unsupported metadata', () => {
    const events: SessionEvent[] = [
      { seq: 0, ts: 1, type: 'message/user', data: { text: 'current', metadata: { secret: 'do-not-forward' } } },
      { seq: 1, ts: 2, type: 'user/message', data: { text: '', source: { kind: 'user', secret: 'do-not-forward-source' } } },
      { seq: 2, ts: 3, type: 'message/user', data: { text: 'preferred', content: [{ type: 'text', text: 'alternate' }] } },
      { seq: 3, ts: 4, type: 'message/user', data: { content: 'string content' } },
      { seq: 4, ts: 5, type: 'user/message', data: null },
      { seq: 5, ts: 6, type: 'message/user', data: { content: [{ type: 'image', data: 'missing-media-type' }] } },
      { seq: 6, ts: 7, type: 'user/message', data: { text: 'injected context', source: { kind: 'model' } } },
    ];

    const messages = projectMessages(events);
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'current' }] },
      { role: 'user', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: [{ type: 'text', text: 'preferred' }] },
      { role: 'user', content: [{ type: 'text', text: 'string content' }] },
      { role: 'user', content: [{ type: 'text', text: 'injected context' }] },
    ]);
    expect(JSON.stringify(messages)).not.toContain('do-not-forward');
  });

  it('rejects a conflicting role and preserves an explicitly empty content array', () => {
    const events: SessionEvent[] = [
      { seq: 0, ts: 1, type: 'user/message', data: { role: 'assistant', content: [{ type: 'text', text: 'not user' }] } },
      { seq: 1, ts: 2, type: 'message/user', data: { role: 'user', content: [] } },
    ];

    expect(projectMessages(events)).toEqual([{ role: 'user', content: [] }]);
  });

  it('keeps valid assistant and tool-result metadata and event order', () => {
    const events: SessionEvent[] = [
      { seq: 0, ts: 1, type: 'message/user', data: { text: 'inspect' } },
      { seq: 1, ts: 2, type: 'assistant/message', data: {
        role: 'assistant', content: [{ type: 'text', text: 'checking' }],
        toolCalls: [{ id: 'c1', name: 'inspect', arguments: { path: 'file' }, raw: '{"path":"file"}' }],
        usage: { inputTokens: 10, outputTokens: 5 },
      } },
      { seq: 2, ts: 3, type: 'tool/result', data: {
        callId: 'c1', name: 'inspect', ok: true, content: 'result', truncated: true,
        fullOutputRef: 'saved-output', durationMs: 42,
      } },
    ];

    expect(projectMessages(events)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'inspect' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'checking' }],
        toolCalls: [{ id: 'c1', name: 'inspect', arguments: { path: 'file' }, raw: '{"path":"file"}' }],
        usage: { inputTokens: 10, outputTokens: 5 } },
      { role: 'tool', results: [{ callId: 'c1', name: 'inspect', ok: true, content: 'result',
        truncated: true, durationMs: 42 }] },
    ]);
  });

  it('restores saved content to a resumed model request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-projection-'));
    try {
      const handle = await new SessionStore(root).create({ id: 'agent', workspace: root, cwd: root });
      await handle.append({ type: 'user/message', data: {
        content: [{ type: 'text', text: 'Describe this' }, { type: 'image', mediaType: 'image/png', data: 'saved-image' }],
      } });
      await handle.append({ type: 'assistant/message', data: {
        role: 'assistant', content: [{ type: 'text', text: 'A picture' }], toolCalls: [],
      } });

      const reopened = await new SessionStore(root).open(root, 'agent');
      const model = new FakeModel([textResponse('continued')]);
      const session = new Session({ cwd: root, model, approve: async () => 'deny', session: reopened });
      for await (const _event of session.send('Continue')) { /* Drain the turn. */ }

      expect(model.requests[0]?.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Describe this' }, { type: 'image', mediaType: 'image/png', data: 'saved-image' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'A picture' }], toolCalls: [] },
        { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
