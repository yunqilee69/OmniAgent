import { describe, expect, it } from 'vitest';
import { assistantText, text, userMessage } from '../domain/message';
import type { Message } from '../domain/message';
import { compactMessages, estimateMessageTokens, estimateMessages } from './compaction';

function toolTurn(): Message[] {
  return [
    userMessage('inspect files'),
    {
      role: 'assistant',
      content: [text('I will inspect them')],
      toolCalls: [{ id: 'call-1', name: 'list_dir', arguments: { path: '.' } }],
    },
    {
      role: 'tool',
      results: [{ callId: 'call-1', name: 'list_dir', ok: true, content: 'a.ts\nb.ts', truncated: false }],
    },
    userMessage('now explain'),
  ];
}

describe('context compaction', () => {
  it('estimates messages deterministically and includes tool arguments/results', () => {
    const messages = toolTurn();
    expect(estimateMessageTokens(messages[1]!)).toBeGreaterThan(estimateMessageTokens(userMessage('x')));
    expect(estimateMessages(messages)).toBe(
      messages.reduce((total, message) => total + estimateMessageTokens(message), 0),
    );
  });

  it('estimates each image independently of its base64 payload size', () => {
    const image = (data: string) => ({ type: 'image' as const, mediaType: 'image/png', data });
    const one: Message = { role: 'user', content: [text('question'), image('a')] };
    const large: Message = { role: 'user', content: [text('question'), image('a'.repeat(4_000_000))] };
    const two: Message = { role: 'user', content: [text('question'), image('a'), image('b')] };
    expect(estimateMessageTokens(large)).toBe(estimateMessageTokens(one));
    expect(estimateMessageTokens(one)).toBeGreaterThan(estimateMessageTokens(userMessage('question')) + 500);
    expect(estimateMessageTokens(two) - estimateMessageTokens(one)).toBeGreaterThan(1000);
  });

  it('preserves protected groups while removing other oversized history', async () => {
    const messages = [userMessage('old '.repeat(300)), userMessage('current '.repeat(300)),
      ...toolTurn().slice(1, 3), userMessage('steer '.repeat(300))];
    const result = await compactMessages(messages, { maxTokens: 10, protectedIndices: [1, 4] });
    expect(result.compacted).toBe(true);
    expect(result.removed).toEqual([messages[0], messages[2], messages[3]]);
    expect(result.protectedIndices).toEqual([1, 2]);
    expect(result.messages.slice(1)).toEqual([messages[1], messages[4]]);
    expect(result.afterTokens).toBeGreaterThan(10);
  });

  it('keeps a protected oversized message unchanged when no history can be removed', async () => {
    const messages = [userMessage('current '.repeat(1000))];
    const result = await compactMessages(messages, { maxTokens: 10, protectedIndices: [0] });
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.removed).toEqual([]);
  });

  it('counts protected context against the history budget', async () => {
    const messages = [userMessage('old '.repeat(100)), userMessage('protected '.repeat(50)),
      userMessage('recent '.repeat(100))];
    const result = await compactMessages(messages, { maxTokens: 200, retainTokens: 150, protectedIndices: [1] });
    expect(result.compacted).toBe(true);
    expect(result.messages).toContainEqual(messages[1]);
    expect(result.messages).not.toContainEqual(messages[2]);
  });

  it('does not split an assistant tool call from its tool result', async () => {
    const messages = toolTurn();
    const result = await compactMessages(messages, {
      maxTokens: 60,
      retainTokens: 8,
      summarize: async (removed) => `summarized ${removed.length} messages`,
    });

    expect(result.compacted).toBe(true);
    expect(result.messages.some((message) => message.role === 'assistant' && message.toolCalls.length > 0)).toBe(false);
    expect(result.messages.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'now explain' }],
    });
    expect(result.messages.find((message) => message.role === 'user')).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: expect.stringContaining('summarized') }],
    });
  });

  it('returns an unchanged copy when within budget', async () => {
    const messages = toolTurn();
    const result = await compactMessages(messages, { maxTokens: 10_000 });
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.messages).not.toBe(messages);
  });

  it('compacts a single oversized group down to the summary', async () => {
    const messages: Message[] = [userMessage('x'.repeat(4_000))];
    const result = await compactMessages(messages, { maxTokens: 10 });
    expect(result.compacted).toBe(true);
    expect(result.removed).toEqual(messages);
    expect(result.messages).toEqual([{
      role: 'user',
      content: [{ type: 'text', text: expect.stringContaining('Earlier conversation compacted') }],
    }]);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  });

  it('keeps an oversized assistant/tool pair together when dropping it', async () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [text('x'.repeat(4_000))],
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { file_path: 'big' } }],
      },
      {
        role: 'tool',
        results: [{ callId: 'call-1', name: 'read_file', ok: true, content: 'y'.repeat(4_000), truncated: false }],
      },
    ];
    const result = await compactMessages(messages, { maxTokens: 10 });
    expect(result.compacted).toBe(true);
    expect(result.removed).toEqual(messages);
    expect(result.messages.some((message) => message.role === 'assistant' || message.role === 'tool')).toBe(false);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  });

  it('rejects a summary that would make the request larger', async () => {
    const messages = toolTurn();
    const result = await compactMessages(messages, {
      maxTokens: 60,
      retainTokens: 8,
      summarize: async () => 'z'.repeat(4_000),
    });
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.afterTokens).toBe(result.beforeTokens);
  });
});
