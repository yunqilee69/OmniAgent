import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationView, elapsedClock, MessageActions, usageDetail, UserContent } from '../ui/src/components/ConversationView.tsx';
import { translator } from '../ui/src/lib/i18n.ts';
import {
  applyAgentEvent,
  createLiveState,
  createSSEParser,
  hydrateTranscript,
  userMessageCopyText,
} from '../ui/src/lib/events.ts';
import {
  eventMetadata,
  safeEventMetadata,
  trajectoryModel,
} from '../ui/src/lib/trajectory.ts';
import { sessionKey, store, type SessionEntry } from '../ui/src/lib/store.ts';
import { attachmentLimitError, MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, MAX_MESSAGE_BODY_BYTES, messageBodyFits, restoreSendAttachment, toWireAttachments, validateContextEstimate } from '../ui/src/lib/wire.ts';

describe('web client protocol', () => {
  it('restores legacy attachments and serializes UTF-8 text as file bytes', () => {
    const image = restoreSendAttachment({ kind: 'image', name: 'a.png', mediaType: 'image/png', data: 'YWJj' });
    const legacy = restoreSendAttachment({ kind: 'text', name: '笔记.txt', mediaType: 'text/plain', text: '你好' });
    expect(image).toEqual({ kind: 'image', name: 'a.png', mimeType: 'image/png', data: 'YWJj' });
    expect(legacy).not.toBeNull();
    expect(toWireAttachments([image!, legacy!])).toEqual([
      { kind: 'image', name: 'a.png', mimeType: 'image/png', data: 'YWJj' },
      { kind: 'file', name: '笔记.txt', mimeType: 'text/plain', data: '5L2g5aW9' },
    ]);
    expect(restoreSendAttachment({ kind: 'file', name: 'x', mimeType: 'application/pdf' })).toBeNull();
  });

  it('applies the same per-file, total and count limits to all attachment types', () => {
    expect(attachmentLimitError(MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES - MAX_ATTACHMENT_BYTES, 7)).toBeNull();
    expect(attachmentLimitError(MAX_ATTACHMENT_BYTES + 1, 0, 0)).toBe('size');
    expect(attachmentLimitError(1, MAX_TOTAL_ATTACHMENT_BYTES, 1)).toBe('total');
    expect(attachmentLimitError(0, 0, 8)).toBe('count');
  });

  it('checks actual request bytes including non-ASCII text and steer metadata', () => {
    const image = { kind: 'image' as const, name: 'a.png', mimeType: 'image/png', data: 'YQ==' };
    expect(messageBodyFits('中文', [image], true)).toBe(true);
    expect(messageBodyFits('界'.repeat(Math.ceil(MAX_MESSAGE_BODY_BYTES / 3)), [image])).toBe(false);
  });
  it('validates context projections and retains legacy unknown fields', () => {
    const value = { modelWindow: 1000, projection: { source: 'usage', projectedTokens: 250, inputTokens: 200,
      breakdown: { systemTokens: 10, toolsTokens: 20, messageTokens: 30 } } };
    expect(validateContextEstimate(value)).toEqual(value);
    expect(validateContextEstimate({ estimatedMessageTokens: 3 })).toEqual({ estimatedMessageTokens: 3 });
    expect(() => validateContextEstimate({ ...value, modelWindow: 0 })).toThrow();
    expect(() => validateContextEstimate({ ...value, projection: { ...value.projection, projectedTokens: -1 } })).toThrow();
    expect(() => validateContextEstimate({ ...value, projection: { ...value.projection, breakdown: {} } })).toThrow();
  });
  it('previews images and displays file names without embedding their data', () => {
    const markup = renderToStaticMarkup(createElement(UserContent, { user: {
      kind: 'user', id: 'u', turn: 0, text: '', attachments: [
        { kind: 'image', name: 'a.png', mimeType: 'image/png', data: 'YQ==' },
        { kind: 'file', name: 'doc.pdf', mimeType: 'application/pdf', data: 'c2VjcmV0' },
        { kind: 'image', name: 'old.png', mediaType: 'image/png', data: 'Yg==' },
      ],
    } }));
    expect(markup).toContain('data:image/png;base64,YQ==');
    expect(markup).toContain('data:image/png;base64,Yg==');
    expect(markup).toContain('doc.pdf');
    expect(markup).not.toContain('c2VjcmV0');
  });

  it('restores structured attachments without exposing model-facing path text', () => {
    const path = `.omniagent/attachments/${'a'.repeat(48)}/0-file.pdf`;
    const part = { type: 'text' as const, text: 'internal path instructions', attachment: {
      kind: 'file' as const, name: 'file.pdf', mediaType: 'application/pdf', filePath: path,
    } };
    const imagePath = `.omniagent/attachments/${'a'.repeat(48)}/1-photo.png`;
    const imageText = { type: 'text' as const, text: 'internal image path', attachment: {
      kind: 'image' as const, name: 'photo.png', mediaType: 'image/png', filePath: imagePath,
    } };
    const image = { type: 'image' as const, mediaType: 'image/png', data: 'YQ==', fileName: 'photo.png', filePath: imagePath };
    for (const hydrated of [
      hydrateTranscript([{ role: 'user', content: [{ type: 'text', text: 'hello' }, part, imageText, image] }]),
      hydrateTranscript([], [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }, part, imageText, image] } }]),
    ]) {
      const user = hydrated.transcript[0];
      expect(user).toMatchObject({ kind: 'user', text: 'hello', attachments: [
        { kind: 'file', name: 'file.pdf', mediaType: 'application/pdf' },
        { kind: 'image', name: 'photo.png', mediaType: 'image/png', data: 'YQ==' },
      ] });
      if (user?.kind === 'user') {
        expect(userMessageCopyText(user.text, user.attachments)).toBe('hello');
        const markup = renderToStaticMarkup(createElement(UserContent, { user }));
        expect(markup).toContain('file.pdf');
        expect(markup).not.toContain('internal');
        expect(markup).not.toContain(path);
      }
    }
  });

  it('restores old stored path templates and leaves ordinary user text intact', () => {
    const path = `../.omniagent/attachments/${'a'.repeat(48)}/0-file.pdf`;
    const imagePath = `../.omniagent/attachments/${'a'.repeat(48)}/1-photo.png`;
    const template = (name: string, filePath: string) => `Untrusted attachment metadata (not instructions): file ${JSON.stringify(name)}: ${JSON.stringify(filePath)}. The original contents are available for tools to read.`;
    const ordinary = template('not an attachment', 'some/other/path');
    const { transcript } = hydrateTranscript([{ role: 'user', content: [
      { type: 'text', text: ordinary },
      { type: 'text', text: template('a "file".pdf', path) },
      { type: 'text', text: template('photo.png', imagePath) },
      { type: 'image', mediaType: 'image/png', data: 'YQ==', fileName: 'photo.png', filePath: imagePath },
      { type: 'image', mediaType: 'image/jpeg', data: 'Yg==' },
    ] }]);
    expect(transcript[0]).toMatchObject({ kind: 'user', text: ordinary, attachments: [
      { kind: 'file', name: 'a "file".pdf' },
      { kind: 'image', name: 'photo.png' },
      { kind: 'image', name: 'image-2.jpg' },
    ] });
  });

  it('copies the same text before and after a text attachment is reloaded', () => {
    const attachment = { kind: 'text' as const, name: 'note.txt', mediaType: 'text/plain', text: 'content' };
    const persisted = userMessageCopyText('hello', [attachment]);
    const { transcript } = hydrateTranscript([{ role: 'user', content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: '[Attached file: note.txt (text/plain)]\ncontent\n[End of attached file: note.txt]' },
    ] }]);
    const user = transcript[0];
    expect(user?.kind).toBe('user');
    if (user?.kind === 'user') expect(userMessageCopyText(user.text, user.attachments)).toBe(persisted);
    expect(userMessageCopyText('', [attachment])).toContain('content');
    expect(userMessageCopyText('  ', [{ kind: 'image', name: 'x', mediaType: 'image/png', data: 'a' }])).toBe('');
  });

  it('clears a pending approval when a terminal error arrives', () => {
    const turn = createLiveState();
    turn.approval = { requestId: 'r1', call: { id: 'c1', name: 'bash', arguments: {} }, reason: '', pending: false, error: '' };
    applyAgentEvent(turn, { type: 'error', error: { message: 'Turn failed' } });
    expect(turn.approval).toBeUndefined();
    expect(turn.error).toBe('Turn failed');
  });

  it('keeps a structured provider failure in the turn notice', () => {
    const turn = createLiveState();
    applyAgentEvent(turn, {
      type: 'error',
      error: {
        message: 'HTTP 503 · all_backends_unavailable: no available backends',
        code: 'all_backends_unavailable',
        status: 503,
        retryable: true,
      },
    });
    expect(turn.error).toBe('HTTP 503 · all_backends_unavailable: no available backends');
    expect(turn.transcript.at(-1)).toMatchObject({
      kind: 'notice',
      tone: 'error',
      text: 'HTTP 503 · all_backends_unavailable: no available backends',
    });
  });
  it('renders accessible copy controls and valid message times', () => {
    const t = translator('en');
    const markup = renderToStaticMarkup(createElement(MessageActions, { text: 'Hello', timestamp: 1234, locale: 'en', t }));
    expect(markup).toContain('aria-label="Copy message"');
    expect(markup).toContain('dateTime="1970-01-01T00:00:01.234Z"');
    // The visible time names the day and the clock, never the year.
    const shown = /<time[^>]*>([^<]*)<\/time>/.exec(markup)?.[1] ?? '';
    expect(shown).toBe(new Date(1234).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
    expect(shown).not.toContain('1970');
    expect(shown).not.toContain('70');
    const absent = renderToStaticMarkup(createElement(MessageActions, { text: '', timestamp: NaN, locale: 'en', t }));
    expect(absent).not.toContain('<time');
    expect(absent).not.toContain('<button');
  });

  it('shows a reply token spend with its input and output split', () => {
    const zh = translator('zh');
    const markup = renderToStaticMarkup(createElement(MessageActions, {
      text: 'Answer', usage: { inputTokens: 1500, outputTokens: 250 }, locale: 'zh', t: zh,
    }));
    // The chip carries a token icon and rides in the hover-revealed action row,
    // the same slot as the timestamp and the copy control.
    expect(markup).toContain('data-icon="dsw-icon-database-outline-regular"');
    expect(markup.indexOf('_actions_')).toBeLessThan(markup.indexOf('data-message-usage'));
    expect(markup).not.toContain('_footer_');
    expect(markup).toContain('1.8K tok');
    expect(usageDetail({ inputTokens: 1500, outputTokens: 250 }, 'zh', zh)).toBe('输入 token 1,500 · 输出 token 250');
    expect(usageDetail({ inputTokens: 1500, outputTokens: 250 }, 'en', translator('en'))).toBe('Input tokens 1,500 · Output tokens 250');
    // A locally resolved call reports no usage and gets no chip.
    const none = renderToStaticMarkup(createElement(MessageActions, {
      text: 'Answer', usage: { inputTokens: 0, outputTokens: 0 }, locale: 'zh', t: zh,
    }));
    expect(none).not.toContain('data-message-usage');
  });

  it('counts the running status in seconds and minutes', () => {
    const zh = translator('zh');
    expect(elapsedClock(zh, 0)).toBe('0秒');
    expect(elapsedClock(zh, 45)).toBe('45秒');
    expect(elapsedClock(zh, 162)).toBe('2分42秒');
    expect(elapsedClock(translator('en'), 162)).toBe('2m42s');
  });


  it('moves a streamed answer into the process without its actions and retains user and final actions', () => {
    const run = createLiveState();
    run.transcript.push({ kind: 'user', id: 'user', turn: 0, text: 'Question', timestamp: 1000 });
    const entry = { agent: null, transcript: [], turns: [], run } as unknown as SessionEntry;
    const snapshot = store.getSnapshot();
    const getSnapshot = vi.spyOn(store, 'getSnapshot').mockReturnValue({ ...snapshot, locale: 'en' });
    // ConversationView uses a layout effect for scrolling, which is inert in server rendering.
    const originalConsoleError = console.error;
    const consoleError = vi.spyOn(console, 'error').mockImplementation((message, ...args) => {
      if (typeof message !== 'string' || !message.includes('useLayoutEffect does nothing on the server')) {
        originalConsoleError(message, ...args);
      }
    });
    const render = () => renderToStaticMarkup(createElement(ConversationView, { entry, processDisplay: 'expanded' }));
    const time = (ms: number) => `dateTime="${new Date(ms).toISOString()}"`;
    const copies = (html: string) => (html.match(/aria-label="Copy message"/g) ?? []).length;
    try {
      applyAgentEvent(run, { type: 'assistant.delta', text: 'Checking' }, 2000);
      const initial = render();
      expect(initial).toContain('Question');
      expect(initial).toContain('Checking');
      expect(initial).toContain(time(1000));
      expect(initial).toContain(time(2000));
      expect(copies(initial)).toBe(2);

      applyAgentEvent(run, { type: 'tool.call', call: { id: 'c1', name: 'read_file', arguments: {} } }, 2500);
      const processing = render();
      expect(processing).toContain('Checking');
      expect(processing).toContain(time(1000));
      expect(processing).not.toContain(time(2000));
      expect(copies(processing)).toBe(1);

      applyAgentEvent(run, { type: 'assistant.delta', text: 'Answer' }, 3000);
      const answered = render();
      expect(answered).toContain('Checking');
      expect(answered).toContain('Answer');
      expect(answered).toContain(time(1000));
      expect(answered).not.toContain(time(2000));
      expect(answered).toContain(time(3000));
      expect(copies(answered)).toBe(2);

      // The same presentation applies after a completed run is loaded from history.
      const history = renderToStaticMarkup(createElement(ConversationView, {
        entry: { ...entry, run: undefined, transcript: run.transcript, turns: run.turns }, processDisplay: 'expanded',
      }));
      expect(history).toContain('Checking');
      expect(history).not.toContain(time(2000));
      expect(history).toContain(time(1000));
      expect(history).toContain(time(3000));
      expect(copies(history)).toBe(2);
    } finally {
      getSnapshot.mockRestore();
      consoleError.mockRestore();
    }
  });

  it('carries a reply token usage from the live stream and from loaded history', () => {
    const run = createLiveState();
    applyAgentEvent(run, { type: 'assistant.delta', text: 'Hi' }, 1000);
    applyAgentEvent(run, {
      type: 'assistant.message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], toolCalls: [], usage: { inputTokens: 200, outputTokens: 30 } },
    }, 1500);
    expect(run.transcript.at(-1)).toMatchObject({ kind: 'assistant', usage: { inputTokens: 200, outputTokens: 30 } });

    const history = hydrateTranscript([
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } },
      // A half-reported usage would read as a cheaper reply, so it is dropped.
      { role: 'assistant', content: [{ type: 'text', text: 'Again' }], toolCalls: [], usage: { inputTokens: 7 } as never },
    ]).transcript;
    expect(history[1]).toMatchObject({ kind: 'assistant', text: 'Hello', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(history[2]).toMatchObject({ kind: 'assistant', text: 'Again' });
    expect(history[2]).not.toHaveProperty('usage');
  });

  it('keeps live turn indices aligned with loaded history', () => {    const turn = createLiveState();
    turn.turns.push({ index: 2, startedAt: 1 });
    applyAgentEvent(turn, { type: 'turn.start' });
    applyAgentEvent(turn, { type: 'assistant.delta', text: 'reply' });
    expect(turn.turns.map((item) => item.index)).toEqual([2]);
    expect(turn.transcript[0]).toMatchObject({ kind: 'assistant', text: 'reply', turn: 2 });
    applyAgentEvent(turn, { type: 'turn.end', reason: 'end_turn' });
    applyAgentEvent(turn, { type: 'turn.start' });
    applyAgentEvent(turn, { type: 'assistant.delta', text: 'next' });
    expect(turn.turns.map((item) => item.index)).toEqual([2, 3]);
    expect(turn.transcript[1]).toMatchObject({ kind: 'assistant', text: 'next', turn: 3 });
  });

  it('correlates projected timeline spans by record ID and never synthesizes missing timing', () => {
    const projection = {
      version: 1,
      turns: [],
      records: [
        { id: 'input-1', kind: 'input', seq: 1, timestamp: null },
        { id: 'tool-1', kind: 'tool', seq: 2, name: 'read_file', durationMs: null, timestamp: 1000 },
      ],
      timeline: {
        sequence: [{ recordId: 'input-1', lane: 'input', start: 0, end: 1 }, { recordId: 'tool-1', lane: 'tools', start: 1, end: 2 }],
        time: [{ recordId: 'tool-1', lane: 'tools', start: 1000, end: 1000 }],
      },
    };
    const sequence = trajectoryModel(projection, 'sequence');
    expect(sequence.spans.map((span) => [span.record.id, span.lane, span.start, span.end])).toEqual([
      ['input-1', 'input', 0, 1], ['tool-1', 'tools', 1, 2],
    ]);
    const timed = trajectoryModel(projection, 'time');
    expect(timed.spans.map((span) => [span.record.id, span.start, span.end])).toEqual([['tool-1', 1000, 1000]]);
    expect(timed.records[0]!.timestamp).toBeNull();
    expect(trajectoryModel(null, 'time').spans).toHaveLength(0);
  });

  it('parses SSE events split across chunks and line endings', () => {
    const events: unknown[] = [];
    const parser = createSSEParser((event) => events.push(event));
    for (const chunk of [': keepalive\r', '\ndata: {"type":"assistant.', 'delta",\r\ndata: "text":"hello"}\r', '\n\r', '\ndata: {"type":"turn.end",', '"reason":"end_turn"}\n\n']) parser.push(chunk);
    parser.finish();
    expect(events).toEqual([{ type: 'assistant.delta', text: 'hello' }, { type: 'turn.end', reason: 'end_turn' }]);
  });

  it('dispatches a complete final frame and rejects malformed JSON', () => {
    const events: unknown[] = [];
    const parser = createSSEParser((event) => events.push(event));
    parser.push('data: {"type":"turn.end"}');
    parser.finish();
    expect(events).toEqual([{ type: 'turn.end' }]);
    expect(() => createSSEParser(() => {}).push('data: not-json\n\n')).toThrow();
  });

  it('hydrates projected messages and associates tool results by call id', () => {
    const { transcript } = hydrateTranscript([
      { role: 'user', content: [{ type: 'text', text: 'Read it' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Checking' }], toolCalls: [{ id: 'c1', name: 'read_file', arguments: { file_path: 'a.txt' } }] },
      { role: 'tool', results: [{ callId: 'c1', name: 'read_file', ok: true, content: 'contents', truncated: false }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done' }], toolCalls: [] },
    ], []);
    expect(transcript.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(transcript[2]).toMatchObject({ call: { id: 'c1' }, result: { content: 'contents', ok: true } });
  });

  it('hydrates authoritative timestamps without inventing missing times', () => {
    const { transcript } = hydrateTranscript([
      { role: 'user', timestamp: 1234, content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', timestamp: 2345, content: [{ type: 'text', text: 'Hello' }] },
      { role: 'user', content: [{ type: 'text', text: 'old' }] },
    ]);
    expect(transcript[0]).toMatchObject({ timestamp: 1234 });
    expect(transcript[1]).toMatchObject({ timestamp: 2345 });
    expect(transcript[2]).not.toHaveProperty('timestamp');
    const live = createLiveState();
    applyAgentEvent(live, { type: 'assistant.delta', text: 'x' }, 4567);
    expect(live.transcript[0]).toMatchObject({ timestamp: 4567 });
  });

  it('hydrates stored message events when projected messages are absent', () => {
    const { transcript } = hydrateTranscript([], [
      { type: 'message/user', data: { text: 'Hello' } },
      { type: 'message/assistant', data: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] } },
    ]);
    expect(transcript.map((item) => [item.kind, item.kind === 'user' || item.kind === 'assistant' ? item.text : '']))
      .toEqual([['user', 'Hello'], ['assistant', 'Hi']]);
  });

  it('replaces streamed deltas with the authoritative assistant message and merges tools', () => {
    const turn = createLiveState();
    applyAgentEvent(turn, { type: 'assistant.delta', text: 'Hel' });
    applyAgentEvent(turn, { type: 'assistant.delta', text: 'lo' });
    applyAgentEvent(turn, { type: 'assistant.message', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }], toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }] } });
    applyAgentEvent(turn, { type: 'tool.call', call: { id: 'c1', name: 'read_file', arguments: { file_path: 'a' } } });
    applyAgentEvent(turn, { type: 'tool.result', result: { callId: 'c1', name: 'read_file', ok: true, content: 'ok', truncated: false } });
    applyAgentEvent(turn, { type: 'turn.start', step: 1 });
    applyAgentEvent(turn, { type: 'assistant.delta', text: 'Done' });
    applyAgentEvent(turn, { type: 'assistant.message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], toolCalls: [] } });
    expect(turn.transcript.map((item) => [item.kind, item.kind === 'assistant' ? item.text : undefined]))
      .toEqual([['assistant', 'Hello!'], ['tool', undefined], ['assistant', 'Done']]);
    expect(turn.transcript[1]).toMatchObject({ call: { id: 'c1', arguments: { file_path: 'a' } }, result: { ok: true } });
  });

  it('keeps event inspection limited to metadata, excluding payloads and audit digests', () => {
    const metadata = eventMetadata({
      type: 'tool.call', seq: 2, ts: 123,
      data: { call: { id: 'c1', name: 'read_file', arguments: { token: 'secret' }, raw: 'secret' } },
      argsDigest: 'secret', source: 'secret',
    });
    expect(metadata).toMatchObject({ Type: 'tool.call', Sequence: 2, 'Tool name': 'read_file', 'Call ID': 'c1' });
    expect(JSON.stringify(metadata)).not.toContain('secret');
    expect(JSON.stringify(eventMetadata({ type: 'error', error: { message: 'secret', code: 'FAILED' } }))).not.toContain('secret');
  });

  it('reads metadata from persisted trace event envelopes without exposing payloads', () => {
    expect(eventMetadata({ type: 'trace/turn.start', seq: 1, ts: 123, data: { step: 2 } }))
      .toMatchObject({ Type: 'trace/turn.start', Step: 2, Sequence: 1 });
    expect(eventMetadata({ type: 'trace/tool.call', data: { id: 'c1', name: 'read_file', arguments: { token: 'secret' } } }))
      .toMatchObject({ 'Tool name': 'read_file', 'Call ID': 'c1' });
    expect(eventMetadata({ type: 'trace/permission.decided', data: { callId: 'c1', decision: 'deny', source: 'secret' } }))
      .toMatchObject({ 'Call ID': 'c1', Decision: 'deny' });
    expect(eventMetadata({ type: 'trace/tool.result', data: { name: 'read_file', callId: 'c1', ok: false, content: 'secret', durationMs: 5 } }))
      .toMatchObject({ 'Tool name': 'read_file', 'Call ID': 'c1', Success: false, 'Duration (ms)': 5 });
    expect(eventMetadata({ type: 'trace/turn.end', data: { reason: 'interrupted' } })).toMatchObject({ Reason: 'interrupted' });
    expect(eventMetadata({ type: 'trace/tool.call', data: { call: { id: 'c2', name: 'other' } } })).toMatchObject({ 'Tool name': 'other', 'Call ID': 'c2' });
    expect(JSON.stringify(eventMetadata({ type: 'trace/tool.result', data: { result: { content: 'secret' } } }))).not.toContain('secret');
  });

  it('allowlists event inspector metadata and rejects arbitrary strings and invalid scalars', () => {
    const secret = 'SECRET_private_path_token';
    expect(safeEventMetadata({ type: 'trace/tool.result', seq: 4, ts: 1000, data: {
      name: 'read_file', callId: secret, content: secret, ok: false, truncated: true, durationMs: 8,
    } })).toMatchObject({ Type: 'trace/tool.result', Sequence: 4, Timestamp: 1000, 'Tool name': 'read_file', Success: false, Truncated: true, 'Duration (ms)': 8 });
    expect(safeEventMetadata({ type: 'trace/context.compacted', data: { beforeTokens: 100, afterTokens: 20 } }))
      .toMatchObject({ 'Before tokens': 100, 'After tokens': 20 });
    expect(safeEventMetadata({ type: 'audit.tool', ts: '2026-01-01T00:00:00Z', data: {
      tool: 'write_file', callId: secret, decision: 'deny', step: 0, ok: false, durationMs: 2, source: secret,
    } })).toMatchObject({ Type: 'audit.tool', Timestamp: Date.parse('2026-01-01T00:00:00Z'), 'Tool name': 'write_file', Decision: 'deny', Step: 0, Success: false, 'Duration (ms)': 2 });
    for (const event of [
      { type: 'trace/tool.call', seq: secret, ts: secret, data: { name: secret, id: secret, arguments: secret } },
      { type: 'trace/permission.decided', data: { callId: secret, decision: secret, source: secret } },
      { type: 'trace/turn.end', data: { reason: secret } },
      { type: 'trace/error', data: { error: { code: secret, message: secret } } },
      { type: 'audit.tool', ts: secret, data: { tool: secret, callId: secret, decision: secret, durationMs: -1, step: 1.5, ok: secret } },
      { type: 'trace/' + secret, data: { message: secret } },
    ]) expect(JSON.stringify(safeEventMetadata(event))).not.toContain(secret);
    expect(safeEventMetadata({ type: 'trace/error', data: { message: 'An error occurred during the turn.' } }))
      .toMatchObject({ Type: 'trace/error', Message: 'An error occurred during the turn.' });
    expect(safeEventMetadata({ type: 'trace/error', data: {
      message: 'HTTP 503 · all_backends_unavailable: no available backends',
      code: 'all_backends_unavailable', status: 503, retryable: true,
    } })).toMatchObject({
      Type: 'trace/error',
      Message: 'HTTP 503 · all_backends_unavailable: no available backends',
      Code: 'all_backends_unavailable',
      Status: 503,
      Retryable: true,
    });
    expect(safeEventMetadata({ type: 'trace/error', data: {
      code: 'not a code', status: 42, retryable: 'yes',
    } })).toEqual({ Type: 'trace/error' });
    // Error text is collapsed to one line and clipped so it can share a table row.
    expect(safeEventMetadata({ type: 'trace/error', data: { message: 'line\nbreak\u0000' } }).Message).toBe('line break');
    expect(String(safeEventMetadata({ type: 'trace/error', data: { message: 'x'.repeat(600) } }).Message)).toHaveLength(500);
    expect(safeEventMetadata({ type: 'trace/' + secret })).toMatchObject({ Type: 'trace/unknown' });
    expect(safeEventMetadata({ type: 'trace/turn.start', seq: -1, ts: Number.MAX_SAFE_INTEGER, data: { step: 1.5 } }))
      .toEqual({ Type: 'trace/turn.start' });
  });

  it('uses unambiguous workspace and session keys', () => {
    expect(sessionKey('a', 'same')).not.toBe(sessionKey('b', 'same'));
    expect(sessionKey('a/b', 'c')).not.toBe(sessionKey('a', 'b/c'));
  });

  it('tracks plan review prompts independently from tool approvals and clears them on turn end', () => {
    const turn = createLiveState();
    applyAgentEvent(turn, { type: 'plan.review.requested', requestId: 'plan-1', plan: '# Plan\n\nDo it.' });
    expect(turn.planReview).toEqual({
      requestId: 'plan-1', plan: '# Plan\n\nDo it.', pending: false, error: '', feedback: '',
    });
    expect(turn.approval).toBeUndefined();
    applyAgentEvent(turn, { type: 'permission.requested', requestId: 'tool-1', call: { id: 'c1', name: 'bash', arguments: {} }, reason: 'approval' });
    expect(turn.approval).toMatchObject({ requestId: 'tool-1' });
    expect(turn.planReview).toMatchObject({ requestId: 'plan-1' });
    applyAgentEvent(turn, { type: 'turn.end', reason: 'end_turn' });
    expect(turn.approval).toBeUndefined();
    expect(turn.planReview).toBeUndefined();
  });
});
