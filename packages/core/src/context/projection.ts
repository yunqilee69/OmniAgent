import { createHash } from 'node:crypto';
import type { Message } from '../domain/message';
import type { ToolSpec } from '../domain/tool';
import { estimateMessages } from './compaction';

export interface ContextBreakdown {
  systemTokens: number;
  toolsTokens: number;
  messageTokens: number;
}

function requestMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    const { usage: _usage, contextSample: _sample, ...request } = message;
    return request;
  });
}

export function contextHistoryHash(messages: readonly Message[]): string {
  return createHash('sha256').update(JSON.stringify(requestMessages(messages))).digest('hex');
}

function estimate(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4);
}

export function contextBreakdown(system: string, tools: readonly ToolSpec[], messages: readonly Message[]): ContextBreakdown {
  return { systemTokens: estimate(system), toolsTokens: estimate(tools), messageTokens: estimateMessages(requestMessages(messages)) };
}

export function projectContext(messages: readonly Message[], system: string, tools: readonly ToolSpec[], provider: string, model: string) {
  const breakdown = contextBreakdown(system, tools, messages);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    // Never revive an older sample after an unmeasured or differently routed
    // response: provider state and replay encoding may have changed.
    if (!message.contextSample || !message.usage || message.usage.inputTokens <= 0) break;
    const sample = message.contextSample;
    if (sample.provider !== provider || sample.model !== model || sample.historyHash !== contextHistoryHash(messages.slice(0, index))) break;
    const delta = breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
      - sample.systemTokens - sample.toolsTokens - sample.messageTokens;
    return { breakdown, projectedTokens: Math.max(0, message.usage.inputTokens + delta), source: 'usage' as const,
      inputTokens: message.usage.inputTokens };
  }
  return { breakdown, projectedTokens: breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens, source: 'estimate' as const };
}
