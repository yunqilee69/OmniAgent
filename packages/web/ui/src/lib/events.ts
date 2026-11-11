import type { AgentEvent, StopReason, ToolCall, ToolResult } from '@omniagent/core';
import type { PublicMessage } from './wire.ts';
import { applyMetricsEvent, type SessionMetrics } from './session-metrics.ts';

let nextItemId = 1;

function itemId(prefix: string): string {
  nextItemId += 1;
  return `${prefix}-${nextItemId}`;
}

export interface UserAttachment {
  kind: 'image' | 'file' | 'text';
  name: string;
  mediaType?: string;
  mimeType?: string;
  data?: string;
  text?: string;
}

/** Match the model-facing text persisted by the server for a live message. */
export function userMessageCopyText(text: string, attachments: readonly UserAttachment[] = []): string {
  if (attachments.length === 0) return text;
  const parts = text.trim() === '' ? [] : [text];
  for (const attachment of attachments) {
    if (attachment.kind === 'text') {
      parts.push(`[Attached file: ${attachment.name} (${attachment.mediaType})]\n${attachment.text ?? ''}\n[End of attached file: ${attachment.name}]`);
    }
  }
  return parts.join('');
}

export interface UserItem {
  kind: 'user';
  id: string;
  turn: number;
  text: string;
  timestamp?: number;
  attachments?: UserAttachment[];
}

/** Token accounting a provider reported for one model call. */
export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AssistantItem {
  kind: 'assistant';
  id: string;
  turn: number;
  text: string;
  timestamp?: number;
  streaming: boolean;
  usage?: MessageUsage;
}

/**
 * Read the token accounting of one message, keeping only a complete pair of
 * non-negative counts: a half-reported usage would read as a cheaper reply.
 */
export function messageUsage(value: unknown): MessageUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as { inputTokens?: unknown; outputTokens?: unknown };
  const tokens = (candidate: unknown): candidate is number =>
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0;
  if (!tokens(record.inputTokens) || !tokens(record.outputTokens)) return undefined;
  return { inputTokens: record.inputTokens, outputTokens: record.outputTokens };
}

export interface ReasoningItem {
  kind: 'reasoning';
  id: string;
  turn: number;
  text: string;
  streaming: boolean;
}

export interface ToolItem {
  kind: 'tool';
  id: string;
  turn: number;
  call: ToolCall;
  result?: ToolResult;
  denied?: boolean;
}

export interface NoticeItem {
  kind: 'notice';
  id: string;
  turn: number;
  tone: 'error' | 'info' | 'warning';
  text: string;
}

export interface CompactionItem {
  kind: 'compaction';
  id: string;
  turn: number;
  beforeTokens: number;
  afterTokens: number;
}

export type TranscriptItem =
  | UserItem
  | AssistantItem
  | ReasoningItem
  | ToolItem
  | NoticeItem
  | CompactionItem;

export interface TurnMeta {
  index: number;
  startedAt?: number;
  endedAt?: number;
  reason?: StopReason;
}

export interface ApprovalRequest {
  requestId: string;
  call: Pick<ToolCall, 'id' | 'name' | 'arguments'>;
  reason: string;
  pending?: boolean;
  error?: string;
}

export interface PlanReviewRequest {
  requestId: string;
  plan: string;
  pending?: boolean;
  error?: string;
  feedback?: string;
}

export interface LiveTurnState {
  transcript: TranscriptItem[];
  turns: TurnMeta[];
  metrics?: SessionMetrics;
  metricsStepsSeen?: number;
  metricsLastStep?: number;
  metricsRunEnded?: boolean;
  streamText: string;
  streamReasoning: string;
  streamAssistantId?: string;
  streamReasoningId?: string;
  approval?: ApprovalRequest;
  planReview?: PlanReviewRequest;
  error?: string;
  stopping?: boolean;
  finishing?: boolean;
  outcome?: StopReason;
}

export function createLiveState(): LiveTurnState {
  return { transcript: [], turns: [], streamText: '', streamReasoning: '' };
}

function currentTurn(turn: LiveTurnState): TurnMeta {
  let latest = turn.turns[turn.turns.length - 1];
  if (latest === undefined || latest.endedAt !== undefined) {
    latest = { index: turn.turns.length, startedAt: Date.now() };
    turn.turns.push(latest);
  }
  return latest;
}

function appendItem<T extends TranscriptItem>(turn: LiveTurnState, item: T): T {
  turn.transcript.push(item);
  return item;
}

function findTool(turn: LiveTurnState, id: string | undefined): ToolItem | undefined {
  if (id === undefined || id === '') return undefined;
  for (let index = turn.transcript.length - 1; index >= 0; index -= 1) {
    const item = turn.transcript[index];
    if (item !== undefined && item.kind === 'tool' && (item.call.id === id || item.result?.callId === id)) return item;
  }
  return undefined;
}

function messageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return '';
  const record = message as { content?: unknown; text?: unknown };
  if (typeof record.content === 'string') return record.content;
  if (Array.isArray(record.content)) {
    return record.content
      .map((part) => typeof part === 'object' && part !== null
        && (part as { type?: unknown }).type === 'text'
        && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '')
      .join('');
  }
  return typeof record.text === 'string' ? record.text : '';
}

// Older stored messages have only the exact model-facing path text. Limit the
// fallback to the original template and storage layout, not arbitrary user text.
function legacyAttachment(text: string): { name: string; filePath: string } | undefined {
  const match = /^Untrusted attachment metadata \(not instructions\): file ("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*")\. The original contents are available for tools to read\.$/.exec(text);
  if (match === null) return undefined;
  try {
    const name: unknown = JSON.parse(match[1]!);
    const filePath: unknown = JSON.parse(match[2]!);
    if (typeof name !== 'string' || typeof filePath !== 'string' ||
        !/(?:^|\/)\.omniagent\/attachments\/[a-f0-9]{48}\/\d+-[^/]+$/.test(filePath)) return undefined;
    return { name, filePath };
  } catch {
    return undefined;
  }
}

function userContent(content: PublicMessage['content']): { text: string; attachments: UserAttachment[] } {
  const attachments: UserAttachment[] = [];
  const text: string[] = [];
  let imageCount = 0;
  if (content === undefined) return { text: '', attachments };
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index];
    if (part === null || typeof part !== 'object') continue;
    if (part.type === 'text') {
      const metadata = part.attachment;
      const legacy = metadata === undefined ? legacyAttachment(part.text) : undefined;
      if (metadata !== undefined || legacy !== undefined) {
        const next = content[index + 1];
        // An image also has a native image part; never render two cards for it.
        const pairedImage = next?.type === 'image' && (metadata?.kind === 'image' ||
          (legacy !== undefined && next.filePath === legacy.filePath));
        if (!pairedImage) {
          attachments.push({ kind: 'file', name: metadata?.name ?? legacy!.name,
            ...(metadata === undefined ? {} : { mediaType: metadata.mediaType }) });
        }
      } else text.push(part.text);
      continue;
    }
    if (part.type !== 'image') continue;
    const extension = part.mediaType === 'image/jpeg' ? 'jpg'
      : part.mediaType === 'image/webp' ? 'webp'
        : part.mediaType === 'image/gif' ? 'gif' : 'png';
    imageCount += 1;
    const previous = content[index - 1];
    const metadata = previous?.type === 'text' ? previous.attachment : undefined;
    const legacy = previous?.type === 'text' ? legacyAttachment(previous.text) : undefined;
    attachments.push({
      kind: 'image',
      name: part.fileName ?? (metadata?.kind === 'image' ? metadata.name : undefined)
        ?? (legacy?.filePath === part.filePath ? legacy?.name : undefined) ?? `image-${imageCount}.${extension}`,
      mediaType: part.mediaType,
      data: part.data,
    });
  }
  return { text: text.join(''), attachments };
}

/**
 * Apply one live AgentEvent to the running turn.
 *
 * The reducer mirrors the DSH event order: a turn is an ordered list of
 * reasoning/assistant/tool items, and `assistant.message` replaces the streamed
 * text rather than appending a second copy.
 */
export function applyAgentEvent(turn: LiveTurnState, event: AgentEvent | Record<string, unknown>, now = Date.now()): void {
  const data = event as Record<string, unknown>;
  const type = typeof data.type === 'string' ? data.type : '';
  if (turn.metrics !== undefined) {
    const step = typeof data.step === 'number' && Number.isSafeInteger(data.step) && data.step >= 0 ? data.step : undefined;
    const newRun = (turn.metricsStepsSeen ?? 0) === 0 || turn.metricsRunEnded === true
      || step === 0 || (step !== undefined && turn.metricsLastStep !== undefined && step <= turn.metricsLastStep);
    applyMetricsEvent(turn.metrics, data, newRun);
    if (type === 'turn.start') {
      turn.metricsStepsSeen = (turn.metricsStepsSeen ?? 0) + 1;
      turn.metricsLastStep = step;
      turn.metricsRunEnded = false;
    } else if (type === 'turn.end') turn.metricsRunEnded = true;
  }
  switch (type) {
    case 'run.user.message': {
      const message = data.message as PublicMessage | undefined;
      if (message?.role !== 'user' || !Array.isArray(message.content)) return;
      const { text, attachments } = userContent(message.content);
      if (text === '' && attachments.length === 0) return;
      const active = currentTurn(turn);
      appendItem(turn, {
        kind: 'user', id: itemId('user'), turn: active.index, text,
        timestamp: typeof data.timestamp === 'number' ? data.timestamp : now,
        ...(attachments.length === 0 ? {} : { attachments }),
      });
      return;
    }
    case 'turn.start': {
      if (turn.turns.length === 0) {
        turn.turns.push({ index: 0, startedAt: now });
      } else {
        const latest = turn.turns[turn.turns.length - 1]!;
        if (latest.endedAt !== undefined) turn.turns.push({ index: latest.index + 1, startedAt: now });
      }
      turn.streamText = '';
      turn.streamReasoning = '';
      turn.streamAssistantId = undefined;
      turn.streamReasoningId = undefined;
      return;
    }
    case 'assistant.reasoning.delta': {
      const text = typeof data.text === 'string' ? data.text : '';
      const meta = currentTurn(turn);
      if (turn.streamReasoningId === undefined) {
        const item = appendItem(turn, {
          kind: 'reasoning',
          id: itemId('reasoning'),
          turn: meta.index,
          text,
          streaming: true,
        });
        turn.streamReasoningId = item.id;
        turn.streamReasoning = text;
      } else {
        const item = turn.transcript.find((candidate) => candidate.id === turn.streamReasoningId);
        if (item?.kind === 'reasoning') item.text += text;
        turn.streamReasoning += text;
      }
      return;
    }
    case 'assistant.delta': {
      const text = typeof data.text === 'string' ? data.text : '';
      const meta = currentTurn(turn);
      if (turn.streamAssistantId === undefined) {
        const item = appendItem(turn, {
          kind: 'assistant',
          id: itemId('assistant'),
          turn: meta.index,
          text,
          timestamp: now,
          streaming: true,
        });
        turn.streamAssistantId = item.id;
        turn.streamText = text;
      } else {
        const item = turn.transcript.find((candidate) => candidate.id === turn.streamAssistantId);
        if (item?.kind === 'assistant') item.text += text;
        turn.streamText += text;
      }
      return;
    }
    case 'assistant.message': {
      const message = data.message as { content?: unknown; toolCalls?: ToolCall[]; usage?: unknown } | undefined;
      const text = messageText(message);
      const meta = currentTurn(turn);
      let assistant: AssistantItem | undefined;
      if (turn.streamAssistantId !== undefined) {
        const item = turn.transcript.find((candidate) => candidate.id === turn.streamAssistantId);
        if (item?.kind === 'assistant') assistant = item;
      }
      if (assistant === undefined && text !== '') {
        assistant = appendItem(turn, {
          kind: 'assistant',
          id: itemId('assistant'),
          turn: meta.index,
          text,
          timestamp: now,
          streaming: false,
        });
      }
      if (assistant !== undefined) {
        assistant.text = text;
        assistant.streaming = false;
        const usage = messageUsage(message?.usage);
        if (usage !== undefined) assistant.usage = usage;
      }
      for (const call of message?.toolCalls ?? []) {
        if (findTool(turn, call.id) === undefined) {
          appendItem(turn, { kind: 'tool', id: itemId('tool'), turn: meta.index, call });
        }
      }
      if (turn.streamReasoningId !== undefined) {
        const reasoning = turn.transcript.find((candidate) => candidate.id === turn.streamReasoningId);
        if (reasoning?.kind === 'reasoning') reasoning.streaming = false;
      }
      turn.streamAssistantId = undefined;
      turn.streamReasoningId = undefined;
      turn.streamText = '';
      turn.streamReasoning = '';
      return;
    }
    case 'tool.call': {
      const call = data.call as ToolCall | undefined;
      if (call === undefined) return;
      const existing = findTool(turn, call.id);
      if (existing === undefined) {
        appendItem(turn, { kind: 'tool', id: itemId('tool'), turn: currentTurn(turn).index, call });
      } else {
        existing.call = { ...existing.call, ...call };
      }
      const assistant = turn.streamAssistantId === undefined
        ? undefined
        : turn.transcript.find((candidate) => candidate.id === turn.streamAssistantId);
      if (assistant?.kind === 'assistant') {
        assistant.streaming = false;
        turn.streamAssistantId = undefined;
        turn.streamText = '';
      }
      return;
    }
    case 'permission.requested': {
      if (turn.stopping === true || turn.outcome !== undefined) return;
      if (typeof data.requestId !== 'string') return;
      const call = typeof data.call === 'object' && data.call !== null
        ? data.call as ApprovalRequest['call']
        : { id: '', name: 'Tool', arguments: {} };
      turn.approval = {
        requestId: data.requestId,
        call,
        reason: typeof data.reason === 'string' ? data.reason : '',
        pending: false,
        error: '',
      };
      return;
    }
    case 'permission.decided': {
      const callId = typeof data.callId === 'string' ? data.callId : undefined;
      if (data.decision === 'deny') {
        const tool = findTool(turn, callId);
        if (tool !== undefined) tool.denied = true;
      }
      if (turn.approval !== undefined && (callId === undefined || turn.approval.call.id === callId)) {
        turn.approval = undefined;
      }
      return;
    }
    case 'plan.review.requested': {
      if (turn.stopping === true || turn.outcome !== undefined) return;
      if (typeof data.requestId !== 'string' || typeof data.plan !== 'string') return;
      turn.planReview = { requestId: data.requestId, plan: data.plan, pending: false, error: '', feedback: '' };
      return;
    }
    case 'plan.review.decided': {
      if (turn.planReview?.requestId === data.requestId) turn.planReview = undefined;
      return;
    }
    case 'tool.result': {
      const result = data.result as ToolResult | undefined;
      if (result === undefined) return;
      const existing = findTool(turn, result.callId);
      if (existing === undefined) {
        appendItem(turn, {
          kind: 'tool',
          id: itemId('tool'),
          turn: currentTurn(turn).index,
          call: { id: result.callId, name: result.name, arguments: {} },
          result,
        });
      } else {
        existing.result = result;
      }
      return;
    }
    case 'context.compacted': {
      appendItem(turn, {
        kind: 'compaction',
        id: itemId('compaction'),
        turn: currentTurn(turn).index,
        beforeTokens: typeof data.beforeTokens === 'number' ? data.beforeTokens : 0,
        afterTokens: typeof data.afterTokens === 'number' ? data.afterTokens : 0,
      });
      return;
    }
    case 'error': {
      const error = typeof data.error === 'object' && data.error !== null
        ? data.error as { message?: unknown }
        : {};
      const text = typeof error.message === 'string' ? error.message : 'The agent reported an error.';
      turn.error = text;
      turn.approval = undefined;
      turn.planReview = undefined;
      appendItem(turn, { kind: 'notice', id: itemId('notice'), turn: currentTurn(turn).index, tone: 'error', text });
      return;
    }
    case 'turn.end': {
      const latest = turn.turns[turn.turns.length - 1];
      if (latest !== undefined && latest.endedAt === undefined) {
        latest.endedAt = now;
        latest.reason = data.reason as StopReason | undefined;
      }
      turn.outcome = typeof data.reason === 'string' ? data.reason as StopReason : 'error';
      turn.approval = undefined;
      turn.planReview = undefined;
      turn.streamAssistantId = undefined;
      turn.streamReasoningId = undefined;
      turn.streamText = '';
      turn.streamReasoning = '';
      for (const item of turn.transcript) {
        if ((item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming) item.streaming = false;
      }
      return;
    }
    default:
      return;
  }
}

/** Build the historical transcript from the public message projection. */
export function hydrateTranscript(messages: readonly PublicMessage[], events: readonly unknown[] = []): {
  transcript: TranscriptItem[];
  turns: TurnMeta[];
} {
  const source = messages.length > 0 ? messages : messagesFromEvents(events);
  const transcript: TranscriptItem[] = [];
  const turns: TurnMeta[] = [];
  let turnIndex = 0;
  let started = false;
  const startTurn = (): number => {
    if (started) turnIndex += 1;
    started = true;
    if (turns[turnIndex] === undefined) turns[turnIndex] = { index: turnIndex };
    return turnIndex;
  };
  for (const message of source) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      const index = startTurn();
      const { text, attachments } = userContent(message.content);
      if (text !== '' || attachments.length > 0) {
        transcript.push({
          kind: 'user', id: itemId('user'), turn: index, text,
          ...(typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) ? { timestamp: message.timestamp } : {}),
          ...(attachments.length === 0 ? {} : { attachments }),
        });
      }
      continue;
    }
    if (message.role === 'assistant') {
      if (!started) startTurn();
      const text = message.content === undefined ? '' : messageText(message);
      const usage = messageUsage(message.usage);
      if (text !== '') {
        transcript.push({ kind: 'assistant', id: itemId('assistant'), turn: turnIndex, text, streaming: false, ...(typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) ? { timestamp: message.timestamp } : {}), ...(usage === undefined ? {} : { usage }) });
      }
      for (const call of message.toolCalls ?? []) {
        if (findToolIn(transcript, call.id) === undefined) {
          transcript.push({ kind: 'tool', id: itemId('tool'), turn: turnIndex, call });
        }
      }
      continue;
    }
    if (message.role === 'tool') {
      for (const result of message.results ?? []) {
        const existing = findToolIn(transcript, result.callId);
        if (existing !== undefined) existing.result = result;
        else {
          transcript.push({
            kind: 'tool',
            id: itemId('tool'),
            turn: turnIndex,
            call: { id: result.callId, name: result.name, arguments: {} },
            result,
          });
        }
      }
    }
  }
  return { transcript, turns };
}

function findToolIn(transcript: readonly TranscriptItem[], id: string): ToolItem | undefined {  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item !== undefined && item.kind === 'tool' && (item.call.id === id || item.result?.callId === id)) return item;
  }
  return undefined;
}

function messagesFromEvents(events: readonly unknown[]): PublicMessage[] {
  const messages: PublicMessage[] = [];
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const record = event as { type?: unknown; data?: unknown };
    const data = typeof record.data === 'object' && record.data !== null
      ? record.data as Record<string, unknown>
      : record as unknown as Record<string, unknown>;
    if (record.type === 'message/user' || record.type === 'user/message') {
      const text = typeof data.content === 'string' ? data.content : typeof data.text === 'string' ? data.text : '';
      messages.push({ role: 'user', content: Array.isArray(data.content)
        ? data.content as PublicMessage['content'] : [{ type: 'text', text }] });
    } else if (record.type === 'message/assistant' || record.type === 'assistant/message') {
      const message = typeof data.message === 'object' && data.message !== null
        ? data.message as PublicMessage
        : data as unknown as PublicMessage;
      messages.push({ role: 'assistant', content: message.content, toolCalls: message.toolCalls });
    } else if (record.type === 'message/tool-result' || record.type === 'tool/result') {
      const result = (typeof data.result === 'object' && data.result !== null ? data.result : data) as ToolResult;
      messages.push({ role: 'tool', results: [result] });
    }
  }
  return messages;
}

export interface DisplayTurn {
  index: number;
  user?: UserItem;
  process: TranscriptItem[];
  final?: AssistantItem;
  extras: TranscriptItem[];
  live: boolean;
  startedAt?: number;
  endedAt?: number;
  reason?: StopReason;
  toolCount: number;
}

/**
 * Collapse the flat transcript into display turns.
 *
 * The last assistant text in a turn is the visible response; earlier assistant
 * narration, reasoning, tools and compaction markers form the turn's process.
 * A turn whose last assistant message still owns tool calls has no response yet.
 */
export function groupTurns(transcript: readonly TranscriptItem[], turns: readonly TurnMeta[], running: boolean): DisplayTurn[] {
  const byTurn = new Map<number, TranscriptItem[]>();
  for (const item of transcript) {
    const list = byTurn.get(item.turn);
    if (list === undefined) byTurn.set(item.turn, [item]);
    else list.push(item);
  }
  const metaByTurn = new Map(turns.map((turn) => [turn.index, turn]));
  const count = Math.max(
    turns.reduce((max, turn) => Math.max(max, turn.index + 1), 0),
    byTurn.size === 0 ? 0 : Math.max(...byTurn.keys()) + 1,
  );
  const result: DisplayTurn[] = [];
  for (let index = 0; index < count; index += 1) {
    const items = byTurn.get(index) ?? [];
    const meta = metaByTurn.get(index);
    let final: AssistantItem | undefined;
    for (let cursor = items.length - 1; cursor >= 0; cursor -= 1) {
      const item = items[cursor];
      if (item?.kind === 'assistant' && item.text.trim() !== '') {
        const hasLaterTool = items.slice(cursor + 1).some((later) => later.kind === 'tool');
        if (!hasLaterTool) final = item;
        break;
      }
    }
    const process: TranscriptItem[] = [];
    const extras: TranscriptItem[] = [];
    let toolCount = 0;
    for (const item of items) {
      if (item === final) continue;
      if (item.kind === 'user') continue;
      if (item.kind === 'notice') {
        extras.push(item);
        continue;
      }
      if (item.kind === 'tool') toolCount += 1;
      if (item.kind === 'assistant' && item.text.trim() === '') continue;
      process.push(item);
    }
    const user = items.find((item): item is UserItem => item.kind === 'user');
    result.push({
      index,
      ...(user === undefined ? {} : { user }),
      process,
      ...(final === undefined ? {} : { final }),
      extras,
      live: running && index === count - 1,
      ...(meta?.startedAt === undefined ? {} : { startedAt: meta.startedAt }),
      ...(meta?.endedAt === undefined ? {} : { endedAt: meta.endedAt }),
      ...(meta?.reason === undefined ? {} : { reason: meta.reason }),
      toolCount,
    });
  }
  return result;
}

/** SSE parser used by the streaming turn; exported for the protocol tests. */
export function createSSEParser(onEvent: (event: unknown) => void): {
  push(chunk: string): void;
  finish(): void;
} {
  let buffer = '';
  let data: string[] = [];
  function line(value: string): void {
    if (value === '') {
      if (data.length > 0) {
        const payload = data.join('\n');
        data = [];
        try {
          onEvent(JSON.parse(payload));
        } catch (error) {
          throw new Error(`Invalid event stream: ${(error as Error).message}`);
        }
      }
      return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let fieldValue = colon < 0 ? '' : value.slice(colon + 1);
    if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
    if (field === 'data') data.push(fieldValue);
  }
  function drain(final: boolean): void {
    let index = 0;
    while (index < buffer.length) {
      let end = index;
      while (end < buffer.length && buffer[end] !== '\r' && buffer[end] !== '\n') end += 1;
      if (end === buffer.length) break;
      if (buffer[end] === '\r' && end + 1 === buffer.length && !final) break;
      line(buffer.slice(index, end));
      index = end + (buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1);
    }
    buffer = buffer.slice(index);
    if (final) {
      if (buffer !== '') line(buffer);
      buffer = '';
      line('');
    }
  }
  return {
    push(chunk) {
      buffer += chunk;
      drain(false);
    },
    finish() {
      drain(true);
    },
  };
}

export { messageText };
