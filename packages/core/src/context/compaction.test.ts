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
