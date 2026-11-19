import { describe, expect, it } from 'vitest';
import { userMessage, type Message } from '../domain/message';
import { contextBreakdown, contextHistoryHash, projectContext } from './projection';

describe('context projection', () => {
  const before = [userMessage('hello')];
  const tools = [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }];
  const sample = () => ({
    role: 'assistant' as const, content: [{ type: 'text' as const, text: 'answer' }], toolCalls: [],
    usage: { inputTokens: 500, outputTokens: 20 },
    contextSample: { provider: 'provider', model: 'model', historyHash: contextHistoryHash(before),
      ...contextBreakdown('system', tools, before) },
  });

  it('anchors to reported input and estimates subsequent surface changes including system and tools', () => {
    const messages: Message[] = [...before, sample(), userMessage('next')];
    const baseline = contextBreakdown('system', tools, before);
    const current = contextBreakdown('longer system', [], messages);
    const result = projectContext(messages, 'longer system', [], 'provider', 'model');
    expect(result).toMatchObject({ source: 'usage', inputTokens: 500, breakdown: current,
      projectedTokens: 500 + current.systemTokens + current.toolsTokens + current.messageTokens
        - baseline.systemTokens - baseline.toolsTokens - baseline.messageTokens });
  });

  it('rejects samples from a different model or a different history and falls back to a complete estimate', () => {
    const messages: Message[] = [...before, sample()];
    expect(projectContext(messages, 'system', tools, 'provider', 'other').source).toBe('estimate');
    expect(projectContext([userMessage('different'), sample()], 'system', tools, 'provider', 'model').source).toBe('estimate');
    const old: Message[] = [userMessage('legacy'), { role: 'assistant', content: [], toolCalls: [], usage: { inputTokens: 800, outputTokens: 3 } }];
    expect(projectContext(old, 'system', tools, 'provider', 'model').source).toBe('estimate');
  });

  it('does not revive older measurements after an unmeasured response or compaction', () => {
    const messages: Message[] = [...before, sample(), { role: 'assistant', content: [], toolCalls: [] }];
    expect(projectContext(messages, 'system', tools, 'provider', 'model').source).toBe('estimate');
    expect(projectContext([userMessage('[conversation summary]'), sample()], 'system', tools, 'provider', 'model').source).toBe('estimate');
  });

  it('ignores provider replay in history hashes and estimates', () => {
    const plain: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      toolCalls: [{ id: 'call-1', name: 'read', arguments: { path: 'a' } }],
    };
    const withReplay: Message = {
      ...plain,
      dshReplay: {
        kind: 'deepseek-messages', version: 1, provider: 'deepseek-official', model: 'model',
        blocks: [
          { type: 'text', text: 'answer' },
          { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a' }, raw: '{"path":"a"}' },
        ],
      },
      providerReplay: {
        kind: 'pi-ai', version: 1, provider: 'provider', model: 'model', api: 'openai',
        content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a' } }],
      },
    };
    // Replay is a transport encoding of the same content: it changes neither the
    // request hash nor its size, so a replay-only difference must not invalidate
    // a measured sample.
    expect(contextHistoryHash([withReplay])).toBe(contextHistoryHash([plain]));
    expect(contextBreakdown('', [], [withReplay])).toEqual(contextBreakdown('', [], [plain]));
  });

  it('ignores metering metadata in history hashes and estimates', () => {
    const message = sample();
    const plain = { role: 'assistant' as const, content: message.content, toolCalls: [] };
    expect(contextHistoryHash([message])).toBe(contextHistoryHash([plain]));
    expect(contextBreakdown('', [], [message])).toEqual(contextBreakdown('', [], [plain]));
  });
});
