/**
 * Durable Host-wide schedule tasks, independently of session activation.
 *
 * DSH stores tasks through its storage-domain service. OmniAgent keeps one
 * JSON file under the config directory and rewrites it atomically, matching the
 * same decoded task shape so service, runtime, and tools can be ported intact.
 * @module @omniagent/core/schedule/store
 */

import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { decodeScheduleRecord } from './domain.ts';
import type {
  ScheduleDeliveryRecord,
  ScheduleDeliveryReceipt,
  ScheduleRecord,
  ScheduleTarget,
} from './types.ts';

/** Durable task value; a delivery receipt does not record model execution completion. */
export interface ScheduleTask {
  record: ScheduleRecord;
  target: ScheduleTarget;
  involvedSessionIds: string[];
  status: 'active' | 'paused' | 'ended';
  createdAt?: string;
  updatedAt?: string;
  lastDelivery?: ScheduleDeliveryReceipt;
  deliveryHistory: {
    records: ScheduleDeliveryRecord[];
    earlierRecordsUnavailable: boolean;
    earlierRecordsPruned: boolean;
  };
  pendingDelivery?: { targetSessionId: string };
}

const recordSchema = z.unknown().transform((value, context): ScheduleRecord => {
  try {
    return decodeScheduleRecord(value);
  } catch (error: unknown) {
    context.addIssue({ code: 'custom', message: String(error) });
  }
  return z.NEVER;
});

const instantSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  'Expected a canonical four-digit-year UTC calendar instant',
).refine((value) => !value.startsWith('0000-'), {
  message: 'Expected a canonical four-digit-year UTC calendar instant',
});

const receiptSchema = z.object({
  scheduledAt: instantSchema,
  deliveredAt: instantSchema,
  messageId: z.string().min(1).refine((value) => value.trim() === value),
  targetSessionId: z.string().min(1),
}).strict();

const createSpecSchema = z.object({
  cwd: z.string().min(1).optional(),
  agentPreset: z.string().min(1).optional(),
}).strict();

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('new_once'), sessionId: z.string().min(1), create: createSpecSchema }).strict(),
  z.object({ kind: z.literal('new'), create: createSpecSchema }).strict(),
]);

const deliveryHistorySchema = z.object({
  records: z.array(receiptSchema.extend({ prompt: z.string().optional() }).strict()),
  earlierRecordsUnavailable: z.boolean(),
  earlierRecordsPruned: z.boolean().default(false),
}).strict().refine(
  (history) => new Set(history.records.map((record) => record.messageId)).size === history.records.length,
  { message: 'Delivery history message identities must be unique within a task' },
);

const taskSchema = z.object({
  record: recordSchema,
  target: targetSchema,
  involvedSessionIds: z.array(z.string().min(1)),
  status: z.enum(['active', 'paused', 'ended']),
  createdAt: instantSchema.optional(),
  updatedAt: instantSchema.optional(),
  lastDelivery: receiptSchema.optional(),
  deliveryHistory: deliveryHistorySchema,
  pendingDelivery: z.object({ targetSessionId: z.string().min(1) }).strict().optional(),
}).strict().transform((task): ScheduleTask => {
  const receipts = [task.lastDelivery, ...task.deliveryHistory.records]
  if (task.target.kind === 'new' && receipts.some((value) => value !== undefined && value.targetSessionId === undefined)) {
    throw new Error('A saved delivery to a fresh session must name its target session');
  }
  const latest = task.deliveryHistory.records.at(-1)
  if (latest !== undefined && task.lastDelivery !== undefined) {
    const { prompt: _prompt, ...receipt } = latest;
    if (JSON.stringify(receipt) !== JSON.stringify(task.lastDelivery)) {
      throw new Error('Last delivery must match the latest saved delivery receipt');
    }
  }
  return task;
});

const fileSchema = z.object({
  version: z.literal(1),
  tasks: z.array(z.unknown()),
}).strict();

/**
 * One JSON-backed task table. Loads and validates every task at open, and
 * writes the whole file after a mutation; schedule catalogs stay small, and the
 * whole-unit write keeps a crash from exposing a partially updated task.
 */
export class ScheduleStore {
  private readonly file: string;
  private tasks = new Map<string, ScheduleTask>();
  private readonly queue: { promise: Promise<void> } = { promise: Promise.resolve() };
  private closed = false;

  constructor(file: string) {
    if (!file) throw new Error('Schedule store path must not be empty');
    this.file = resolve(file);
  }

  async open(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return;
      throw new Error(`Cannot read schedule file "${this.file}"`, { cause: error });
    }
    let parsed: z.infer<typeof fileSchema>;
    try {
      parsed = fileSchema.parse(JSON.parse(text));
    } catch (error) {
      throw new Error(`Invalid schedule file "${this.file}"`, { cause: error });
    }
    this.tasks = new Map();
    for (const value of parsed.tasks) {
      const task = taskSchema.parse(value);
      if (this.tasks.has(task.record.id)) throw new Error(`Duplicate schedule id "${task.record.id}"`);
      this.tasks.set(task.record.id, task);
    }
  }

  entries(): Array<[string, ScheduleTask]> {
    return [...this.tasks.entries()];
  }

  get(id: string): ScheduleTask | undefined {
    return this.tasks.get(id);
  }

  async put(id: string, task: ScheduleTask): Promise<void> {
    if (this.tasks.get(id) === task) return;
    this.tasks.set(id, task);
    await this.persist();
  }

  async delete(id: string): Promise<boolean> {
    if (!this.tasks.delete(id)) return false;
    await this.persist();
    return true;
  }

  async deleteMany(ids: readonly string[]): Promise<number> {
    let removed = 0;
    for (const id of ids) {
      if (this.tasks.delete(id)) removed += 1;
    }
    if (removed > 0) await this.persist();
    return removed;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue.promise;
  }

  private persist(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Schedule store is closed'));
    const payload = `${JSON.stringify({ version: 1, tasks: [...this.tasks.values()] }, null, 2)}\n`;
    const write = this.queue.promise.then(() => this.writeFile(payload));
    this.queue.promise = write.catch(() => undefined);
    return write;
  }

  private async writeFile(payload: string): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await file.writeFile(payload, 'utf8');
      await file.sync();
    } finally {
      await file?.close();
    }
    try {
      await rename(temporary, this.file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    const directory = await open(dirname(this.file), 'r');
    try {
      await directory.sync();
    } catch {
      // Some platforms cannot fsync a directory; the rename is still atomic.
    } finally {
      await directory.close();
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}
