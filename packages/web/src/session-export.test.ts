import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeModel, Session, SessionLog, SessionStore, sessionPath, textResponse, toolCallResponse } from '@omniagent/core';
import { replayEndpointHash } from '../../core/src/providers/replay-identity';
import { exportSession } from './session-export';

describe('exportSession', () => {
  it('returns a versioned JSON transcript for a committed session', async () => {
    const log = new SessionLog({ id: 'example', workspace: '/workspace', cwd: '/workspace', createdAt: 1 });
    await log.append({ type: 'message/user', data: { text: 'Hello' } });
    await log.append({ type: 'message/assistant', data: {
      role: 'assistant', content: [{ type: 'text', text: 'Hi' }], toolCalls: [],
    } });

    const result = exportSession(log, 'json');

    expect(result.mimeType).toBe('application/json; charset=utf-8');
    expect(result.filename).toMatch(/^omniagent-session-[a-f0-9]{64}\.json$/);
    expect(JSON.parse(result.text)).toEqual({
      format: 'omniagent-session-transcript',
      version: 1,
      entries: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      ],
    });
  });

  it('exports tool activity and image placeholders without exposing non-transcript data', async () => {
    const log = new SessionLog({ id: 'shared', workspace: '/private/project', cwd: '/private/cwd', createdAt: 1 });
    await log.append({ type: 'system/message', data: { text: 'SYSTEM SECRET' } });
    await log.append({ type: 'user/message', data: { text: 'Question', secret: 'USER METADATA SECRET' } });
    await log.append({ type: 'assistant/message', data: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Inspecting' }, { type: 'image', mediaType: 'image/png', data: 'IMAGE SECRET' }],
      toolCalls: [
        { id: 'same', name: 'read_file', arguments: { file_path: '/private/argument', token: 'ARGUMENT SECRET' }, raw: 'RAW SECRET' },
        { id: 'same', name: 'search', arguments: { query: 'another secret' } },
      ],
    } });
    await log.append({ type: 'trace/tool.call', data: { name: 'DUPLICATE TRACE', arguments: 'TRACE SECRET' } });
    await log.append({ type: 'tool/result', data: { callId: 'same', name: 'read_file', ok: true,
      content: 'first output', truncated: true, fullOutputRef: '/private/full-output', durationMs: 3 } });
    await log.append({ type: 'message/tool-result', data: { result: { callId: 'same', name: 'search', ok: false,
      content: 'second output', truncated: false, audit: 'AUDIT SECRET' } } });
    await log.append({ type: 'trace/permission.decided', data: { decision: 'allow', rule: 'PERMISSION SECRET' } });
    await log.append({ type: 'audit/tool', data: { token: 'AUDIT SECRET' } });
    await log.append({ type: 'message/assistant', data: {
      role: 'assistant', content: [{ type: 'text', text: 'Done' }], toolCalls: [],
    } });

    const exported = exportSession(log, 'json');
    expect(JSON.parse(exported.text).entries).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'Question' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Inspecting' }, { type: 'image', omitted: true }] },
      { type: 'tool_call', callId: 'same', name: 'read_file' },
      { type: 'tool_call', callId: 'same', name: 'search' },
      { type: 'tool_result', callId: 'same', name: 'read_file', ok: true, content: 'first output', truncated: true },
      { type: 'tool_result', callId: 'same', name: 'search', ok: false, content: 'second output', truncated: false },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    ]);
    expect(exported.text).not.toMatch(/SECRET|\/private|DUPLICATE TRACE|audit|permission/i);
  });

  it('retains usable partial message and tool data without inventing missing results', async () => {
    const log = new SessionLog({ id: 'partial', workspace: '/workspace', cwd: '/workspace', createdAt: 1 });
    await log.append({ type: 'message/user', data: null });
    await log.append({ type: 'message/user', data: { content: [{ type: 'text', text: 'partial user' }, null] } });
    await log.append({ type: 'message/assistant', data: { content: [{ type: 'text', text: 'partial assistant' }, null],
      toolCalls: [{ name: 'tool' }, null, { id: 'only-id' }] } });
    await log.append({ type: 'message/tool-result', data: { result: { name: 'tool' } } });
    await log.append({ type: 'message/tool-result', data: null });
    await log.append({ type: 'message/assistant', data: { role: 'system', content: [{ type: 'text', text: 'NOT ASSISTANT' }] } });

    expect(JSON.parse(exportSession(log, 'json').text).entries).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'partial user' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'partial assistant' }] },
      { type: 'tool_call', callId: null, name: 'tool' },
      { type: 'tool_call', callId: 'only-id', name: 'unknown' },
      { type: 'tool_result', callId: null, name: 'tool', ok: null, content: null, truncated: null },
    ]);
  });

  it('renders messages and tools as safely fenced Markdown in chronological order', async () => {
    const log = new SessionLog({ id: 's', workspace: '/workspace', cwd: '/workspace', createdAt: 1 });
    const user = 'Hello 😀\n```\n## Forged heading\n</details>\n';
    const output = '````\n</details>\n~~~\nfinished\n';
    await log.append({ type: 'message/user', data: { text: user } });
    await log.append({ type: 'message/assistant', data: {
      role: 'assistant', content: [{ type: 'text', text: 'Working\n```js\nopen fence' }],
      toolCalls: [{ id: 'call\n## fake', name: 'read`file', arguments: { secret: 'omit' } }],
    } });
    await log.append({ type: 'message/tool-result', data: { result: {
      callId: 'call\n## fake', name: 'read`file', ok: false, content: output, truncated: true,
    } } });
    await log.append({ type: 'message/assistant', data: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], toolCalls: [] } });

    const exported = exportSession(log, 'markdown');
    expect(exported.mimeType).toBe('text/markdown; charset=utf-8');
    expect(exported.filename).toMatch(/^omniagent-session-[a-f0-9]{64}\.md$/);
    expect(exported.text).toBe([
      '# Session transcript',
      '', '## User', '', '````text', user, '````',
      '', '## Assistant', '', '````text', 'Working\n```js\nopen fence', '````',
      '', '## Tool call', '', '**Tool name:**', '', '```text', 'read`file', '```',
      '', '**Call ID:**', '', '```text', 'call\n## fake', '```',
      '', '## Tool result', '', '**Tool name:**', '', '```text', 'read`file', '```',
      '', '**Call ID:**', '', '```text', 'call\n## fake', '```',
      '', '**Status:** failed', '', '**Truncated:** yes', '', '**Output:**', '',
      '`````text', output, '`````',
      '', '## Assistant', '', '```text', 'Done', '```', '',
    ].join('\n'));
    expect(exported.text).not.toContain('secret');
  });

  it('represents missing results and image bytes explicitly without implying success', async () => {
    const log = new SessionLog({ id: 's', workspace: '/workspace', cwd: '/workspace', createdAt: 1 });
    await log.append({ type: 'message/assistant', data: { content: [{ type: 'image', data: 'secret bytes' }] } });
    await log.append({ type: 'message/tool-result', data: { result: { name: 'tool' } } });
    const markdown = exportSession(log, 'markdown').text;
    expect(markdown).toContain('[Image omitted]');
    expect(markdown).toContain('**Status:** unknown');
    expect(markdown).toContain('**Truncated:** unknown');
    expect(markdown).toContain('**Output:** not recorded');
    expect(markdown).not.toContain('secret bytes');
  });

  it('keeps filenames safe, deterministic and distinct across scope and sanitized-name collisions', () => {
    const makeLog = (id: string, workspace: string) => new SessionLog({ id, workspace, cwd: workspace, createdAt: 1 });
    const logs = [
      makeLog('../same\r\n"/😀', '/a-b'),
      makeLog('../same\r\n"/😀', '/a/b'),
      makeLog('../same\r\n"/😀', '/a-b-2'),
      makeLog('../same\r\n"/😁', '/a-b'),
      makeLog(`${'a'.repeat(400)}x`, '/a-b'),
      makeLog(`${'a'.repeat(400)}y`, '/a-b'),
      makeLog('\ud800', '/a-b'),
      makeLog('\ud801', '/a-b'),
    ];
    const filenames = logs.map((log) => exportSession(log, 'json').filename);
    expect(new Set(filenames).size).toBe(logs.length);
    expect(logs.map((log) => exportSession(log, 'json').filename)).toEqual(filenames);
    for (const filename of filenames) {
      expect(filename).toMatch(/^omniagent-session-[a-f0-9]{64}\.json$/);
      expect(Buffer.byteLength(filename)).toBeLessThan(255);
    }
    expect(exportSession(logs[0]!, 'markdown').filename.replace(/\.md$/, '.json')).toBe(filenames[0]);
  });

  it('preserves long Unicode content and does not mutate its snapshot', async () => {
    const log = new SessionLog({ id: 'long', workspace: '/workspace', cwd: '/workspace', createdAt: 1 });
    const text = `${'a😀\n'.repeat(100_000)}終`;
    await log.append({ type: 'message/user', data: { text } });
    await log.append({ type: 'message/tool-result', data: { result: { name: 'tool', content: text, ok: true, truncated: false } } });
    const session = Object.freeze({ header: log.header, events: log.events });
    const before = JSON.stringify(session);
    const json = exportSession(session, 'json');
    const entries = JSON.parse(json.text).entries;
    expect(entries[0].content[0].text).toBe(text);
    expect(entries[1].content).toBe(text);
    const markdown = exportSession(session, 'markdown');
    expect(markdown.text.split(text)).toHaveLength(3);
    expect(JSON.stringify(session)).toBe(before);
  });

  it('handles empty sessions and rejects unknown formats', () => {
    const log = new SessionLog({ id: 'empty', workspace: '/workspace', cwd: '/workspace', createdAt: 1 });
    expect(exportSession(log, 'markdown').text).toBe('# Session transcript\n');
    expect(JSON.parse(exportSession(log, 'json').text).entries).toEqual([]);
    expect(() => exportSession(log, 'html' as 'json')).toThrow('Unsupported session export format');
  });

  it('withholds a generic DSH denial and private metadata from a real scoped session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-export-'));
    try {
      const store = new SessionStore(join(root, 'sessions'));
      const workspace = join(root, 'private-workspace');
      const handle = await store.create({ id: 'same-id', workspace, cwd: workspace });
      const other = await store.create({ id: 'same-id', workspace: join(root, 'other'), cwd: join(root, 'other') });
      await other.append({ type: 'message/user', data: { text: 'OTHER WORKSPACE SECRET' } });
      const toolResponse = toolCallResponse([{ id: 'c1', name: 'read_file', args: { file_path: 'SECRET ARGUMENT' } }], 'Inspecting');
      toolResponse.message.dshReplay = {
        kind: 'deepseek-messages', version: 1, provider: 'deepseek-official', model: 'test',
        endpoint: replayEndpointHash('https://api.deepseek.com/anthropic/v1/messages'),
        blocks: [{ type: 'thinking', thinking: 'SECRET DSH REPLAY' }],
      };
      toolResponse.message.providerReplay = {
        kind: 'pi-ai', version: 1, provider: 'test', model: 'test', api: 'test',
        content: [{ type: 'thinking', thinking: 'SECRET PROVIDER REPLAY' }],
      };
      const session = new Session({
        cwd: workspace,
        model: new FakeModel([toolResponse, textResponse('Done')]),
        rules: [{ raw: 'SECRET PERMISSION RULE', tool: 'read_file', source: 'session', decision: 'deny', anchor: workspace }],
        approve: async () => 'deny',
        session: handle,
      });
      for await (const _event of session.send('hello')) { /* Drain the committed turn. */ }
      await handle.append({ type: 'trace/internal', data: { details: 'SECRET INTERNAL TRACE' } });
      const reopened = await new SessionStore(join(root, 'sessions')).open(workspace, 'same-id');
      const persisted = await readFile(sessionPath(join(root, 'sessions'), workspace, 'same-id'), 'utf8');
      expect(persisted).not.toContain('SECRET PERMISSION RULE');
      expect(persisted).toContain('DSH permission selection is required');
      expect(persisted).toContain('SECRET ARGUMENT');
      expect(persisted).toContain('SECRET DSH REPLAY');
      expect(persisted).toContain('SECRET PROVIDER REPLAY');
      expect(persisted).toContain('SECRET INTERNAL TRACE');
      expect(persisted).toContain('trace/permission.decided');
      expect(reopened.events).toContainEqual(expect.objectContaining({
        type: 'trace/permission.decided', data: { callId: 'c1', decision: 'deny' },
      }));
      expect(reopened.events).toContainEqual(expect.objectContaining({
        type: 'message/tool-result', data: { result: {
          callId: 'c1', name: 'read_file', ok: false,
          content: expect.stringContaining('DSH permission selection is required'), truncated: false,
        } },
      }));

      const json = exportSession(reopened, 'json');
      expect(JSON.parse(json.text).entries).toEqual([
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Inspecting' }] },
        { type: 'tool_call', callId: 'c1', name: 'read_file' },
        { type: 'tool_result', callId: 'c1', name: 'read_file', ok: false,
          content: null, truncated: false, contentOmitted: 'permission' },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
      ]);
      const markdown = exportSession(reopened, 'markdown').text;
      expect(markdown).toContain('**Output:** withheld (permission denial)');
      expect(markdown).toContain('**Status:** failed');
      for (const visible of ['hello', 'Inspecting', 'Done', 'read_file', 'c1']) {
        expect(markdown).toContain(visible);
      }
      for (const exported of [json.text, markdown]) {
        expect(exported).not.toMatch(/SECRET|private-workspace|DSH permission selection is required|trace\/|dshReplay|providerReplay|arguments/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('pairs permission decisions with duplicate and out-of-order call IDs without hiding unrelated output', async () => {
    const log = new SessionLog({ id: 's', workspace: '/workspace', cwd: '/workspace', createdAt: 1 });
    await log.append({ type: 'trace/permission.decided', data: { callId: 'duplicate', decision: 'deny' } });
    await log.append({ type: 'trace/permission.decided', data: { callId: 'other', decision: 'allow' } });
    await log.append({ type: 'trace/permission.decided', data: { callId: 'duplicate', decision: 'allow' } });
    await log.append({ type: 'message/tool-result', data: { result: { callId: 'other', name: 'tool', ok: true, content: 'other output' } } });
    await log.append({ type: 'message/tool-result', data: { result: { callId: 'duplicate', name: 'tool', ok: false, content: 'private rule' } } });
    await log.append({ type: 'message/tool-result', data: { result: { callId: 'duplicate', name: 'tool', ok: true, content: 'later output' } } });
    const results = JSON.parse(exportSession(log, 'json').text).entries;
    expect(results.map((entry: { content: string | null }) => entry.content)).toEqual(['other output', null, 'later output']);
    expect(results[1].contentOmitted).toBe('permission');
    expect(exportSession(log, 'json').text).not.toContain('private rule');
  });

  it('withholds recognizable legacy permission denials even when the trace is absent', async () => {
    const log = new SessionLog({ id: 'legacy', workspace: '/workspace', cwd: '/workspace', createdAt: 1 });
    await log.append({ type: 'tool/result', data: { callId: 'a', name: 'tool', ok: false,
      content: '调用被权限策略拒绝（命中 deny 规则 SECRET RULE）。不要重试同一调用，换一种方式或向用户说明。', truncated: false } });
    expect(JSON.stringify(log.events)).toContain('SECRET RULE');
    const json = exportSession(log, 'json').text;
    expect(json).not.toContain('SECRET RULE');
    expect(JSON.parse(json).entries[0]).toMatchObject({ content: null, contentOmitted: 'permission' });
    const markdown = exportSession(log, 'markdown').text;
    expect(markdown).toContain('**Output:** withheld (permission denial)');
    expect(markdown).not.toContain('SECRET RULE');
  });

  it('withholds legacy denial output when its success status is missing or null', async () => {
    const log = new SessionLog({ id: 'legacy', workspace: '/workspace', cwd: '/workspace', createdAt: 1 });
    const content = '调用被权限策略拒绝（命中 deny 规则 SECRET RULE）。不要重试同一调用。';
    await log.append({ type: 'tool/result', data: { callId: 'a', name: 'tool', content } });
    await log.append({ type: 'message/tool-result', data: { result: { callId: 'b', name: 'tool', ok: null, content } } });
    for (const format of ['json', 'markdown'] as const) {
      const text = exportSession(log, format).text;
      expect(text).not.toContain('SECRET RULE');
    }
    expect(JSON.parse(exportSession(log, 'json').text).entries).toMatchObject([
      { content: null, contentOmitted: 'permission' },
      { content: null, contentOmitted: 'permission' },
    ]);
  });

  it('does not export explicitly injected non-user context', async () => {
    const log = new SessionLog({ id: 's', workspace: '/workspace', cwd: '/workspace', createdAt: 1 });
    await log.append({ type: 'user/message', data: { text: 'VISIBLE', source: { kind: 'user' } } });
    await log.append({ type: 'user/message', data: { text: 'INJECTED SECRET', source: { kind: 'model' } } });
    for (const format of ['json', 'markdown'] as const) {
      const text = exportSession(log, format).text;
      expect(text).toContain('VISIBLE');
      expect(text).not.toContain('INJECTED SECRET');
    }
  });

  it('does not apply a previous incomplete turn\'s permission to a reused call ID', async () => {
    const log = new SessionLog({ id: 's', workspace: '/workspace', cwd: '/workspace', createdAt: 1 });
    await log.append({ type: 'trace/turn.start', data: { step: 0 } });
    await log.append({ type: 'trace/permission.decided', data: { callId: 'same', decision: 'allow' } });
    await log.append({ type: 'trace/turn.end', data: { reason: 'interrupted' } });
    await log.append({ type: 'trace/turn.start', data: { step: 0 } });
    await log.append({ type: 'trace/permission.decided', data: { callId: 'same', decision: 'deny' } });
    await log.append({ type: 'message/tool-result', data: { result: {
      callId: 'same', name: 'tool', ok: false, content: 'SECRET RULE', truncated: false,
    } } });
    const json = exportSession(log, 'json').text;
    expect(json).not.toContain('SECRET RULE');
    expect(JSON.parse(json).entries[0]).toMatchObject({ content: null, contentOmitted: 'permission' });
  });
});
