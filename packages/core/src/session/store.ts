import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { appendFile, chmod, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { withSessionLock } from './file-lock';
import { cloneJson, SESSION_FORMAT_VERSION, SessionEventSchema, SessionHeaderSchema } from './types';
import type { SessionEvent, SessionEventInput, SessionHeader } from './types';

const StoredHeaderSchema = z.object({
  type: z.literal('session'),
  version: z.number().int(),
  id: z.string(),
  workspace: z.string(),
  cwd: z.string(),
  createdAt: z.number().int(),
  agentId: z.string().optional(),
  parentSessionId: z.string().optional(),
  depth: z.number().int().optional(),
  description: z.string().optional(),
});

export function encodeSegment(value: string): string {
  if (value.length === 0) throw new Error('cannot encode an empty path segment');
  if (value === '.') return '~002E';
  if (value === '..') return '~002E~002E';
  let encoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const char = String.fromCharCode(code);
    encoded += char !== '~' && /^[A-Za-z0-9._-]$/.test(char)
      ? char
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return encoded;
}

function legacyWorkspaceKey(workspace: string): string {
  if (workspace.length === 0) throw new Error('cannot encode an empty workspace');
  let readable = '';
  let inSeparator = false;
  for (let index = 0; index < workspace.length; index += 1) {
    const code = workspace.charCodeAt(index);
    const char = String.fromCharCode(code);
    if (char === '/' || char === '\\' || char === ':') {
      if (!inSeparator) readable += '-';
      inSeparator = true;
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char;
      inSeparator = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      inSeparator = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

export function workspaceKey(workspace: string): string {
  const slug = legacyWorkspaceKey(workspace).slice(2, -2).slice(0, 160);
  const digest = createHash('sha256').update(workspace, 'utf16le').digest('hex');
  return `--${slug}--${digest}`;
}

export function sessionPath(root: string, workspace: string, agentId: string): string {
  return join(root, workspaceKey(workspace), encodeSegment(agentId), 'session.jsonl');
}

function legacySessionPath(root: string, workspace: string, id: string): string {
  return join(root, legacyWorkspaceKey(workspace), encodeSegment(id), 'session.jsonl');
}

function parseHeader(text: string): SessionHeader {
  const firstLine = text.split('\n', 1)[0];
  if (!firstLine) throw new Error('invalid session header');
  const candidate = StoredHeaderSchema.parse(JSON.parse(firstLine));
  if (candidate.version !== SESSION_FORMAT_VERSION) throw new Error('unsupported session format');
  return SessionHeaderSchema.parse(candidate);
}

function parseLog(text: string, workspace: string, id: string): { log: SessionLog; tornTail: boolean } {
  const header = parseHeader(text);
  if (header.id !== id || header.workspace !== workspace) throw new Error('session identity mismatch');
  const lines = text.split('\n');
  lines.shift();
  if (lines.at(-1) === '') lines.pop();
  const events: SessionEvent[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) throw new Error('invalid empty session event');
    try {
      events.push(SessionEventSchema.parse(JSON.parse(line)));
    } catch (error) {
      throw new Error('invalid session event; original log was preserved', { cause: error });
    }
    if (events.at(-1)?.seq !== index) throw new Error(`invalid session event sequence at ${index}`);
  }
  return { log: new SessionLog(header, events), tornTail: false };
}

interface ActiveSession {
  path: string;
  log: SessionLog;
  dirty: boolean;
}

const queues = new Map<string, Promise<void>>();
const activeSessions = new Map<string, WeakRef<ActiveSession>>();
const MAX_ACTIVE_SESSIONS = 128;

function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => undefined, () => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return result;
}

function cachedSession(key: string): ActiveSession | undefined {
  const session = activeSessions.get(key)?.deref();
  if (session === undefined) activeSessions.delete(key);
  return session;
}

export interface SessionSummary {
  id: string;
  agent?: string;
  agentId?: string;
  parentSessionId?: string;
  depth?: number;
  description?: string;
  workspace: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  eventCount: number;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value) as T;
}

export class SessionLog {
  readonly header: SessionHeader;
  private readonly log: SessionEvent[];
  private nextSeq: number;
  private snapshot: readonly SessionEvent[] | undefined;

  constructor(
    header: Omit<SessionHeader, 'type' | 'version' | 'createdAt'> & Partial<Pick<SessionHeader, 'createdAt'>>,
    events: SessionEvent[] = [],
  ) {
    this.header = SessionHeaderSchema.parse({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      createdAt: header.createdAt ?? Date.now(),
      ...header,
    });
    this.log = events.map((event) => deepFreeze(SessionEventSchema.parse(cloneJson(event))));
    this.nextSeq = this.log.length;
    for (const [index, event] of this.log.entries()) {
      if (event.seq !== index) throw new Error(`session events must be contiguous at ${index}`);
    }
    Object.freeze(this.header);
  }

  get events(): readonly SessionEvent[] {
    return this.snapshot ??= Object.freeze([...this.log]);
  }

  get messages(): readonly SessionEvent[] {
    return this.events.filter(({ type }) => ['system/message', 'user/message', 'assistant/message', 'message/user', 'message/assistant', 'message/tool-result', 'tool/result'].includes(type));
  }

  sync(other: SessionLog): void {
    if (other === this) return;
    this.log.length = 0;
    for (const event of other.log) this.log.push(event);
    this.nextSeq = this.log.length;
    this.snapshot = undefined;
  }

  async append(input: SessionEventInput): Promise<SessionEvent> {
    const event = SessionEventSchema.parse({
      seq: input.seq ?? this.nextSeq,
      ts: input.ts ?? Date.now(),
      type: input.type,
      data: cloneJson(input.data),
    });
    if (event.seq !== this.nextSeq) {
      throw new Error(`session append must be contiguous: expected ${this.nextSeq}, got ${event.seq}`);
    }
    const frozen = deepFreeze(event);
    this.log.push(frozen);
    this.nextSeq += 1;
    this.snapshot = undefined;
    return cloneJson(frozen);
  }
}

export class SessionStore {
  private readonly active = new Map<string, ActiveSession>();
  private readonly root: string;

  constructor(root: string) { this.root = resolve(root); }

  async create(input: {
    id?: string;
    agentId?: string;
    workspace: string;
    cwd: string;
    parentSessionId?: string;
    depth?: number;
    description?: string;
  }): Promise<SessionHandle> {
    const id = input.id ?? input.agentId ?? randomUUID();
    const path = sessionPath(this.root, input.workspace, id);
    return serialize(path, () => withSessionLock(path, async () => {
      if (await this.readOptional(path) !== undefined) throw new Error(`session "${id}" already exists`);
      const oldText = await this.readOptional(legacySessionPath(this.root, input.workspace, id));
      if (oldText !== undefined) {
        const header = parseHeader(oldText);
        if (header.workspace === input.workspace && header.id === id) throw new Error(`session "${id}" already exists`);
      }
      const log = new SessionLog({
        id,
        agentId: input.agentId ?? id,
        workspace: input.workspace,
        cwd: input.cwd,
        ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
        ...(input.depth === undefined ? {} : { depth: input.depth }),
        ...(input.description === undefined ? {} : { description: input.description }),
      });
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      let file;
      try {
        file = await open(path, 'wx', 0o600);
      } catch (error) {
        if (isAlreadyExists(error)) throw new Error(`session "${id}" already exists`, { cause: error });
        throw error;
      }
      try {
        await file.writeFile(`${JSON.stringify(log.header)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDirectory(dirname(path));
      const session = { path, log, dirty: false };
      this.remember(path, session);
      return new SessionHandle(this, path, log);
    }));
  }

  async open(workspace: string, id: string): Promise<SessionHandle> {
    const modernPath = sessionPath(this.root, workspace, id);
    return serialize(modernPath, () => withSessionLock(modernPath, async () => {
      let path = modernPath;
      let text = await this.readOptional(path);
      if (text === undefined) {
        path = legacySessionPath(this.root, workspace, id);
        text = await readFile(path, 'utf8');
      }
      const missingFinalNewline = !text.endsWith('\n');
      if (missingFinalNewline) text += '\n';
      const header = parseHeader(text);
      if (header.id !== id || header.workspace !== workspace) throw new Error('session identity mismatch');
      const cached = cachedSession(modernPath);
      const sameSession = cached?.path === path && sameHeader(cached.log.header, header);
      if (cached?.dirty) {
        if (!sameSession) throw new Error('session changed while unflushed events exist');
        await this.persistUnlocked(path, cached.log);
        cached.dirty = false;
        text = await readFile(path, 'utf8');
      }
      const { log } = parseLog(text, workspace, id);
      if (missingFinalNewline) {
        // A complete final record without a newline can be normalized only after parsing it.
        await this.persistUnlocked(path, log);
      }
      const session = sameSession && cached !== undefined ? cached : { path, log, dirty: false };
      if (session === cached) cached.log.sync(log);
      this.remember(modernPath, session);
      return new SessionHandle(this, path, session.log);
    }));
  }

  async list(): Promise<SessionSummary[]> {
    const summaries = new Map<string, { summary: SessionSummary; modern: boolean; path: string }>();
    const workspaces = await readDirOptional(this.root);
    for (const workspaceDir of workspaces) {
      const workspacePath = join(this.root, workspaceDir);
      const agents = await readDirOptional(workspacePath);
      for (const agentDir of agents) {
        const path = join(workspacePath, agentDir, 'session.jsonl');
        const text = await this.readOptional(path);
        if (text === undefined) continue;
        let header: SessionHeader;
        let log: SessionLog;
        let modern: boolean;
        try {
          header = parseHeader(text);
          modern = path === sessionPath(this.root, header.workspace, header.id);
          if (!modern && path !== legacySessionPath(this.root, header.workspace, header.id)) continue;
          ({ log } = parseLog(text, header.workspace, header.id));
        } catch {
          continue;
        }
        if (!modern && await pathExists(sessionPath(this.root, header.workspace, header.id))) continue;
        const key = this.key(header.workspace, header.id);
        const existing = summaries.get(key);
        if (existing === undefined || (modern && !existing.modern)) {
          summaries.set(key, { summary: toSummary(log), modern, path });
        }
      }
    }
    for (const [key, session] of this.active) {
      const existing = summaries.get(key);
      if (session.dirty && existing?.path === session.path && sameSummaryHeader(existing.summary, session.log.header)) {
        summaries.set(key, { ...existing, summary: toSummary(session.log) });
      }
    }
    return Array.from(summaries.values(), ({ summary }) => summary);
  }

  async append(path: string, event: SessionEvent): Promise<void> {
    await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: constants.O_APPEND | constants.O_WRONLY });
  }

  async persistUnlocked(path: string, log: SessionLog): Promise<void> {
    const header = parseHeader(await readFile(path, 'utf8'));
    if (!sameHeader(header, log.header)) throw new Error('session identity mismatch');
    const content = [JSON.stringify(log.header), ...log.events.map((event) => JSON.stringify(event))].join('\n') + '\n';
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await syncDirectory(dirname(path));
  }

  async appendToSession(path: string, log: SessionLog, input: SessionEventInput): Promise<SessionEvent> {
    const modernPath = sessionPath(this.root, log.header.workspace, log.header.id);
    return serialize(modernPath, () => withSessionLock(modernPath, async () => {
      const session = this.active.get(this.key(log.header.workspace, log.header.id));
      if (session?.dirty) {
        await this.persistUnlocked(session.path, session.log);
        session.dirty = false;
      }
      const target = await realpath(path);
      const file = await open(target, constants.O_RDWR);
      let original: Buffer;
      let originalStat: BigIntStats;
      let baseLog: SessionLog;
      try {
        original = await file.readFile();
        const text = original.toString('utf8');
        const header = parseHeader(text);
        if (!sameHeader(header, log.header)) throw new Error('session identity mismatch');
        originalStat = await file.stat({ bigint: true });
        if (!originalStat.isFile()) throw new Error('session path is not a regular file');
        baseLog = parseLog(text, log.header.workspace, log.header.id).log;
      } finally {
        await file.close();
      }
      const staged = new SessionLog(log.header, [...baseLog.events]);
      const event = await staged.append(input);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      const temporaryFile = await open(temporary, 'wx', 0o600);
      let committed = false;
      try {
        try {
          await temporaryFile.writeFile(original);
        } finally {
          await temporaryFile.close();
        }
        await this.append(temporary, event);
        await chmod(temporary, Number(originalStat.mode & 0o777n));
        await syncFile(temporary);
        const current = await stat(target, { bigint: true });
        if (await realpath(path) !== target || current.dev !== originalStat.dev || current.ino !== originalStat.ino
          || current.size !== originalStat.size || current.mtimeNs !== originalStat.mtimeNs
          || current.ctimeNs !== originalStat.ctimeNs) {
          throw new Error('session changed during append');
        }
        await rename(temporary, target);
        committed = true;
      } finally {
        if (!committed) await unlink(temporary).catch((error: unknown) => { if (!isNotFound(error)) throw error; });
      }
      await syncDirectory(dirname(target));
      log.sync(staged);
      return event;
    }));
  }

  async flushSession(path: string, log: SessionLog): Promise<void> {
    const modernPath = sessionPath(this.root, log.header.workspace, log.header.id);
    await serialize(modernPath, () => withSessionLock(modernPath, async () => {
      const session = this.active.get(this.key(log.header.workspace, log.header.id));
      if (session?.dirty) {
        await this.persistUnlocked(path, log);
        session.dirty = false;
      }
    }));
  }

  private remember(modernPath: string, session: ActiveSession): void {
    const key = this.key(session.log.header.workspace, session.log.header.id);
    this.active.delete(key);
    this.active.set(key, session);
    activeSessions.set(modernPath, new WeakRef(session));
    if (this.active.size <= MAX_ACTIVE_SESSIONS) return;
    for (const [candidateKey, candidate] of this.active) {
      if (this.active.size <= MAX_ACTIVE_SESSIONS) break;
      if (candidate.dirty || candidate === session) continue;
      this.active.delete(candidateKey);
      const candidatePath = sessionPath(this.root, candidate.log.header.workspace, candidate.log.header.id);
      if (activeSessions.get(candidatePath)?.deref() === candidate) activeSessions.delete(candidatePath);
    }
  }

  private async readOptional(path: string): Promise<string | undefined> {
    try { return await readFile(path, 'utf8'); } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private key(workspace: string, id: string): string { return JSON.stringify([workspace, id]); }
}

export class SessionHandle {
  constructor(private readonly store: SessionStore, private readonly path: string, readonly log: SessionLog) {}
  get id(): string { return this.log.header.id; }
  get header(): SessionHeader { return this.log.header; }
  get events(): readonly SessionEvent[] { return this.log.events; }
  get messages(): readonly SessionEvent[] { return this.log.messages; }
  async append(input: SessionEventInput): Promise<SessionEvent> {
    return this.store.appendToSession(this.path, this.log, input);
  }
  async flush(): Promise<void> { await this.store.flushSession(this.path, this.log); }
  async close(): Promise<void> { await this.flush(); }
}

function sameHeader(left: SessionHeader, right: SessionHeader): boolean {
  return left.id === right.id && left.workspace === right.workspace && left.cwd === right.cwd
    && left.createdAt === right.createdAt && left.agentId === right.agentId
    && left.parentSessionId === right.parentSessionId && left.depth === right.depth
    && left.description === right.description;
}

function sameSummaryHeader(summary: SessionSummary, header: SessionHeader): boolean {
  return summary.id === header.id && summary.workspace === header.workspace && summary.cwd === header.cwd
    && summary.createdAt === header.createdAt && summary.agentId === header.agentId
    && summary.parentSessionId === header.parentSessionId && summary.depth === header.depth
    && summary.description === header.description;
}

function toSummary(log: SessionLog): SessionSummary {
  const events = log.events;
  return {
    id: log.header.id,
    ...(log.header.agentId === undefined ? {} : { agentId: log.header.agentId }),
    ...(log.header.parentSessionId === undefined ? {} : { parentSessionId: log.header.parentSessionId }),
    ...(log.header.depth === undefined ? {} : { depth: log.header.depth }),
    ...(log.header.description === undefined ? {} : { description: log.header.description }),
    workspace: log.header.workspace,
    cwd: log.header.cwd,
    createdAt: log.header.createdAt,
    updatedAt: events.at(-1)?.ts ?? log.header.createdAt,
    eventCount: events.length,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if (isNotFound(error)) return false; throw error; }
}

/** Flush a completed temp file before its rename makes it visible. */
async function syncFile(path: string): Promise<void> {
  const file = await open(path, 'r');
  try { await file.sync(); } finally { await file.close(); }
}

/** Persist the directory entry after a rename; unsupported platforms skip it. */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readDirOptional(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch (error) { if (isNotFound(error)) return []; throw error; }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'EEXIST';
}
