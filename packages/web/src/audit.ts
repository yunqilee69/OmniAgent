import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditEntry } from '@omniagent/core';

const MAX_AUDIT_READ_BYTES = 2 * 1024 * 1024;
const MAX_AUDIT_ENTRIES = 1000;

export interface WebAuditEntry {
  ts: string;
  sessionId: string;
  step: number;
  tool: string;
  callId: string;
  decision: 'allow' | 'ask' | 'deny';
  ok?: boolean;
  durationMs?: number;
}

function auditPath(configDir: string, workspace: string): string {
  const key = createHash('sha256').update(workspace, 'utf16le').digest('hex');
  return join(configDir, 'web-audit', `${key}.jsonl`);
}

async function auditDirectory(configDir: string, create: boolean): Promise<boolean> {
  const directory = join(configDir, 'web-audit');
  if (create) {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  try {
    const info = await lstat(directory);
    if (!info.isDirectory()) throw new Error('Web audit path must be a directory');
    return true;
  } catch (error) {
    if (!create && isNotFound(error)) return false;
    throw error;
  }
}

async function openRegular(path: string, flags: number, mode?: number) {
  const file = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Web audit path must be a regular file');
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function recordWorkspaceAudit(configDir: string, workspace: string, entry: AuditEntry): Promise<void> {
  await auditDirectory(configDir, true);
  const file = await openRegular(
    auditPath(configDir, workspace),
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
    0o600,
  );
  try {
    await file.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
  } finally {
    await file.close();
  }
}

export async function readWorkspaceAudit(configDir: string, workspace: string, sessionId: string): Promise<WebAuditEntry[]> {
  if (!(await auditDirectory(configDir, false))) return [];
  let file;
  try {
    file = await openRegular(auditPath(configDir, workspace), constants.O_RDONLY);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const entries: WebAuditEntry[] = [];
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Web audit path must be a regular file');
    const start = Math.max(0, info.size - MAX_AUDIT_READ_BYTES);
    const length = info.size - start;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await file.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    let text = buffer.subarray(0, offset).toString('utf8');
    // A tail read starts mid-line; discard that partial record.
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : '';
    }
    for (const line of text.split('\n')) {
      if (line.length > 64 * 1024) continue;
      try {
        const value: unknown = JSON.parse(line);
        const entry = parseEntry(value, sessionId);
        if (!entry) continue;
        entries.push(entry);
        if (entries.length > MAX_AUDIT_ENTRIES) entries.shift();
      } catch {
        continue;
      }
    }
  } finally {
    await file.close();
  }
  return entries;
}

function parseEntry(value: unknown, sessionId: string): WebAuditEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  if (entry.sessionId !== sessionId || typeof entry.ts !== 'string' ||
      typeof entry.step !== 'number' || !Number.isInteger(entry.step) ||
      typeof entry.tool !== 'string' || typeof entry.callId !== 'string' ||
      (entry.decision !== 'allow' && entry.decision !== 'ask' && entry.decision !== 'deny')) return undefined;
  return {
    ts: entry.ts,
    sessionId,
    step: entry.step,
    tool: entry.tool,
    callId: entry.callId,
    decision: entry.decision,
    ...(typeof entry.ok === 'boolean' ? { ok: entry.ok } : {}),
    ...(typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs) ? { durationMs: entry.durationMs } : {}),
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
