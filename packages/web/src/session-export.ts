import { createHash } from 'node:crypto';
import type { SessionEvent, SessionHandle } from '@omniagent/core';

export type SessionExportFormat = 'markdown' | 'json';
export interface SessionExport {
  text: string;
  mimeType: string;
  filename: string;
}

export type SessionTranscriptContent = { type: 'text'; text: string } | { type: 'image'; omitted: true };
export type SessionTranscriptEntry =
  | { type: 'message'; role: 'user' | 'assistant'; content: SessionTranscriptContent[] }
  | { type: 'tool_call'; callId: string | null; name: string }
  | { type: 'tool_result'; callId: string | null; name: string; ok: boolean | null; content: string | null; truncated: boolean | null; contentOmitted?: 'permission' };

/**
 * JSON transcript schema v1, not a DSH ZIP/JSONL archive or a resumable log.
 * Entries retain persisted order; tool calls and results remain separate even
 * when their IDs collide. Text and available tool output are unchanged. Image
 * bytes are replaced by `{ type: 'image', omitted: true }`. Unknown tool IDs,
 * statuses, output, and truncation flags are `null`; a missing name is
 * `'unknown'`. `contentOmitted: 'permission'` means denial output was withheld
 * because permission denial details may be sensitive, not because output was unrecorded.
 *
 * Only allowlisted conversation fields are included. System/injected context,
 * metadata, tool arguments, internal output references, trace and audit records
 * are excluded. Tool outputs may already be truncated in the stored session;
 * they are never fetched separately. No redaction is attempted inside included
 * user/assistant text, tool names/IDs, or tool output, all of which may contain
 * secrets or paths and must be reviewed before sharing.
 */
export interface SessionTranscript {
  format: 'omniagent-session-transcript';
  version: 1;
  entries: SessionTranscriptEntry[];
}

/**
 * Formats one already-authorized, workspace-scoped session snapshot without I/O.
 * Callers must resolve the workspace and open that session first; this function
 * neither performs lookup nor enforces access control. Only committed events
 * supplied by the handle are included; no live deltas or descendants are read.
 *
 * Markdown uses literal fenced blocks for untrusted text, rather than interpreting
 * authored Markdown. JSON follows {@link SessionTranscript}. The output is fully
 * buffered and never silently truncated. The filename uses a SHA-256 digest of
 * the workspace/session identity for collision resistance, not anonymization.
 * Unknown formats throw; HTTP status and attachment headers belong to the caller.
 */
export function exportSession(
  session: Pick<SessionHandle, 'header' | 'events'>,
  format: SessionExportFormat,
): SessionExport {
  if (format !== 'json' && format !== 'markdown') throw new Error('Unsupported session export format');
  const entries = transcriptEntries(session.events);
  const digest = createHash('sha256').update(JSON.stringify([session.header.workspace, session.header.id]), 'utf16le').digest('hex');
  const transcript: SessionTranscript = { format: 'omniagent-session-transcript', version: 1, entries };
  return format === 'json' ? {
    text: `${JSON.stringify(transcript, null, 2)}\n`,
    mimeType: 'application/json; charset=utf-8',
    filename: `omniagent-session-${digest}.json`,
  } : {
    text: markdown(entries),
    mimeType: 'text/markdown; charset=utf-8',
    filename: `omniagent-session-${digest}.md`,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function contentParts(value: unknown): SessionTranscriptContent[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) return [];
  const parts: SessionTranscriptContent[] = [];
  for (const item of value) {
    const part = record(item);
    if (part?.type === 'text' && typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
    else if (part?.type === 'image') parts.push({ type: 'image', omitted: true });
  }
  return parts;
}

function transcriptEntries(events: readonly SessionEvent[]): SessionTranscriptEntry[] {
  const entries: SessionTranscriptEntry[] = [];
  const decisions = new Map<string, Array<'allow' | 'deny'>>();
  for (const event of events) {
    if (event.type === 'trace/turn.start' || event.type === 'trace/turn.end') {
      decisions.clear();
      continue;
    }
    const data = record(event.data);
    if (!data) continue;
    if (event.type === 'trace/permission.decided') {
      if (typeof data.callId === 'string' && (data.decision === 'allow' || data.decision === 'deny')) {
        const queue = decisions.get(data.callId) ?? [];
        queue.push(data.decision);
        decisions.set(data.callId, queue);
      }
      continue;
    }
    if (event.type === 'message/user' || event.type === 'user/message') {
      if (data.role !== undefined && data.role !== 'user') continue;
      if (data.source !== undefined && record(data.source)?.kind !== 'user') continue;
      const content = contentParts(typeof data.text === 'string' ? data.text : data.content);
      if (content.length) entries.push({ type: 'message', role: 'user', content });
    } else if (event.type === 'message/assistant' || event.type === 'assistant/message') {
      if (data.role !== undefined && data.role !== 'assistant') continue;
      const content = contentParts(data.content);
      if (content.length) entries.push({ type: 'message', role: 'assistant', content });
      if (!Array.isArray(data.toolCalls)) continue;
      for (const value of data.toolCalls) {
        const call = record(value);
        if (!call || (typeof call.id !== 'string' && typeof call.name !== 'string')) continue;
        entries.push({
          type: 'tool_call',
          callId: typeof call.id === 'string' ? call.id : null,
          name: typeof call.name === 'string' && call.name ? call.name : 'unknown',
        });
      }
    } else if (event.type === 'message/tool-result' || event.type === 'tool/result') {
      const result = 'result' in data ? record(data.result) : data;
      if (!result) continue;
      const callId = typeof result.callId === 'string' ? result.callId : null;
      const decision = callId === null ? undefined : decisions.get(callId)?.shift();
      const withheld = decision === 'deny';
      entries.push({
        type: 'tool_result',
        callId,
        name: typeof result.name === 'string' && result.name ? result.name : 'unknown',
        ok: typeof result.ok === 'boolean' ? result.ok : null,
        content: withheld ? null : typeof result.content === 'string' ? result.content : null,
        truncated: typeof result.truncated === 'boolean' ? result.truncated : null,
        ...(withheld ? { contentOmitted: 'permission' as const } : {}),
      });
    }
  }
  return entries;
}

function fenced(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

function markdown(entries: readonly SessionTranscriptEntry[]): string {
  const sections = ['# Session transcript'];
  for (const entry of entries) {
    if (entry.type === 'message') {
      sections.push(`## ${entry.role === 'user' ? 'User' : 'Assistant'}`);
      for (const part of entry.content) {
        sections.push(part.type === 'text' ? fenced(part.text) : '[Image omitted]');
      }
    } else {
      sections.push(entry.type === 'tool_call' ? '## Tool call' : '## Tool result');
      sections.push('**Tool name:**', fenced(entry.name));
      if (entry.callId !== null) sections.push('**Call ID:**', fenced(entry.callId));
      if (entry.type === 'tool_result') {
        sections.push(`**Status:** ${entry.ok === null ? 'unknown' : entry.ok ? 'succeeded' : 'failed'}`);
        sections.push(`**Truncated:** ${entry.truncated === null ? 'unknown' : entry.truncated ? 'yes' : 'no'}`);
        if (entry.contentOmitted === 'permission') sections.push('**Output:** withheld (permission denial)');
        else if (entry.content === null) sections.push('**Output:** not recorded');
        else sections.push('**Output:**', fenced(entry.content));
      }
    }
  }
  return `${sections.join('\n\n')}\n`;
}
