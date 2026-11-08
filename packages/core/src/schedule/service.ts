/**
 * Host-wide durable reminders and shared human/model management.
 *
 * Ported from DSH's Schedule service without plugin service injection; the
 * host composition supplies a delivery callback and a JSON store path.
 * @module @omniagent/core/schedule/service
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ScheduleRuntime } from './runtime.ts';
import type { ScheduleDeliveryHost, ScheduleRuntimeLimits } from './runtime.ts';
import { ScheduleStore } from './store.ts';
import type { ScheduleTask } from './store.ts';
import { deliveryHistoryPage } from './delivery-history.ts';
import { createScheduleRecord, updateScheduleRecord } from './update.ts';
import { scheduleId, ScheduleInputError, MIN_EVERY_INTERVAL_SECONDS } from './domain.ts';
import type {
  ScheduleCatalogEntry,
  ScheduleCreateRequest,
  ScheduleDeleteInactiveResult,
  ScheduleDeliveryHistoryRequest,
  ScheduleDeliveryHistoryResult,
  ScheduleEditRequest,
  ScheduleEditResult,
  ScheduleListRequest,
  ScheduleListResult,
  ScheduleNotFoundResult,
  SchedulePatch,
  ScheduleRunRequest,
  ScheduleRunResult,
  ScheduleSessionCreateSpec,
  ScheduleTarget,
  ScheduleTargetRequest,
  ScheduleViewRequest,
  ScheduleViewResult,
} from './types.ts';

/** Retained delivery-history window applied when the deployment states none. */
const DEFAULT_DELIVERY_HISTORY_DAYS = 30;

/** Retained delivery-history record cap applied when the deployment states none. */
const DEFAULT_DELIVERY_HISTORY_RECORDS = 200;

/** Spacing between session-creating deliveries of one task applied when the deployment states none. */
const DEFAULT_NEW_SESSION_INTERVAL_SECONDS = 60;

/** Page size of a task list request that states none. */
export const DEFAULT_LIST_LIMIT = 100;

/** Largest page size of one task list request. */
export const MAX_LIST_LIMIT = 500;

/** Stable refusal text for a target session that a delegated child owns. */
const SUBAGENT_SESSION_REFUSAL = 'This session belongs to subagent routing, which never receives reminder delivery.';

export interface ScheduleServiceOptions {
  /** JSON file that stores every task. */
  file: string;
  /** Session validation and delivery implementation. */
  host: ScheduleDeliveryHost;
  /** Delivery-history window retained per task, in days. */
  deliveryHistoryDays?: number;
  /** Retained delivery records per task. */
  deliveryHistoryRecords?: number;
  /** Shortest spacing between two session-creating deliveries of one task, in seconds. */
  newSessionIntervalSeconds?: number;
  /** Diagnostics sink for delivery failures. */
  log?: (message: string) => void;
}

/** Keep actionable schedules first and pagination stable across equal timestamps. */
function compareEntries(left: ScheduleCatalogEntry, right: ScheduleCatalogEntry): number {
  const status = Number(left.status !== 'active') - Number(right.status !== 'active');
  if (status !== 0) return status;
  if (left.status === 'active' && right.status === 'active') {
    return left.scheduledAt.localeCompare(right.scheduledAt) || left.id.localeCompare(right.id);
  }
  const leftRecent = left.lastDelivery?.deliveredAt ?? left.updatedAt ?? left.createdAt ?? left.scheduledAt;
  const rightRecent = right.lastDelivery?.deliveredAt ?? right.updatedAt ?? right.createdAt ?? right.scheduledAt;
  return rightRecent.localeCompare(leftRecent) || left.id.localeCompare(right.id);
}

/**
 * Resolve the page bounds of a task list request.
 */
function resolveListPage(request: ScheduleListRequest): { readonly limit: number; readonly offset: number } {
  const limit = request.limit ?? DEFAULT_LIST_LIMIT;
  const offset = request.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT
    || !Number.isSafeInteger(offset) || offset < 0) {
    throw new ScheduleInputError('invalid_rule', `limit must be 1-${MAX_LIST_LIMIT} and offset must be a non-negative integer.`);
  }
  return { limit, offset };
}

/**
 * Copy the present creation values of a requested destination.
 */
function createSpec(spec: ScheduleSessionCreateSpec | undefined): ScheduleSessionCreateSpec {
  if (spec?.cwd === '' || spec?.agentPreset === '') {
    throw new ScheduleInputError('invalid_rule', 'target create cwd and agentPreset must be non-empty when present.');
  }
  return {
    ...(spec?.cwd === undefined ? {} : { cwd: spec.cwd }),
    ...(spec?.agentPreset === undefined ? {} : { agentPreset: spec.agentPreset }),
  };
}

/**
 * Add the acting session and the existing or reserved target session to the
 * involved sessions.
 */
function involved(
  actorSessionId: string | undefined,
  target: ScheduleTarget,
  previous: readonly string[],
): string[] {
  const ids = new Set(previous);
  if (actorSessionId !== undefined) ids.add(actorSessionId);
  if (target.kind !== 'new') ids.add(target.sessionId);
  return [...ids];
}

/** Change time strictly after the stored one, so `expectedUpdatedAt` detects every later change. */
function revisedAt(task: ScheduleTask, now: number): string {
  return new Date(Math.max(now, task.updatedAt === undefined ? now : Date.parse(task.updatedAt) + 1)).toISOString();
}

/** Apply one atomic edit through the same timing evaluator as creation. */
function revisedTask(
  current: ScheduleTask,
  patch: SchedulePatch,
  target: ScheduleTarget | undefined,
  actorSessionId: string | undefined,
  now: number,
): ScheduleTask {
  const nextTarget = target ?? current.target;
  const record = updateScheduleRecord(current.record, patch, now, patch.active === true);
  const changedRule = !isDeepStrictEqual(
    { ...record, title: current.record.title, prompt: current.record.prompt },
    current.record,
  );
  const updatedAt = revisedAt(current, now);
  const retargeted = target !== undefined && !isDeepStrictEqual(target, current.target);
  let status = current.status;
  if (patch.active === false) status = 'paused';
  else if (patch.active === true || changedRule && current.status === 'ended') status = 'active';
  const { pendingDelivery, ...kept } = current;
  return {
    ...kept,
    record,
    target: nextTarget,
    involvedSessionIds: involved(actorSessionId, nextTarget, current.involvedSessionIds),
    status,
    updatedAt,
    ...(pendingDelivery === undefined || changedRule || retargeted ? {} : { pendingDelivery }),
  };
}

/**
 * Shared management service; reads and management writes never activate a
 * session, and only delivery creates or resumes one.
 */
export class ScheduleService {
  private readonly store: ScheduleStore;
  private readonly host: ScheduleDeliveryHost;
  private readonly limits: ScheduleRuntimeLimits;
  private readonly log: (message: string) => void;
  private runtime: ScheduleRuntime | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private stopping = false;

  constructor(options: ScheduleServiceOptions) {
    this.store = new ScheduleStore(options.file);
    this.host = options.host;
    this.log = options.log ?? (() => undefined);
    this.limits = {
      retention: {
        days: options.deliveryHistoryDays ?? DEFAULT_DELIVERY_HISTORY_DAYS,
        records: options.deliveryHistoryRecords ?? DEFAULT_DELIVERY_HISTORY_RECORDS,
      },
      newSessionIntervalMs: (options.newSessionIntervalSeconds ?? DEFAULT_NEW_SESSION_INTERVAL_SECONDS) * 1_000,
    };
  }

  /** Load tasks from disk and arm the nearest timer. */
  async open(): Promise<void> {
    await this.store.open();
    this.runtime = new ScheduleRuntime(
      () => this.store.entries().map(([, task]) => task),
      (work) => this.serialize(work),
      async (task) => {
        await this.store.put(task.record.id, task);
        this.emitChanged();
      },
      () => { this.emitChanged(); },
      this.limits,
      this.host,
      this.log,
    );
    this.runtime.requestDrive();
  }

  /** Stop the timer and drain an accepted delivery. */
  async close(): Promise<void> {
    this.stopping = true;
    await this.runtime?.dispose();
    await this.chain;
    await this.store.close();
  }

  /** Read effective delivery limits. */
  deliveryLimits(): { readonly newSessionIntervalSeconds: number } {
    return { newSessionIntervalSeconds: this.limits.newSessionIntervalMs / 1_000 };
  }

  /**
   * Create one task and record the acting agent's session as involved.
   */
  async create(
    request: ScheduleCreateRequest,
    actorSessionId?: string,
    signal?: AbortSignal,
  ): Promise<ScheduleCatalogEntry> {
    const id = scheduleId(`schedule-${randomUUID()}`);
    const now = Date.now();
    const record = createScheduleRecord(id, request.title, request.prompt, request.timing, now);
    const target = await this.resolveTarget(request.target ?? { kind: 'new_once' }, signal);
    return this.serialize(async () => {
      signal?.throwIfAborted();
      await this.validateTarget(target, signal);
      signal?.throwIfAborted();
      const createdAt = new Date(now).toISOString();
      const task: ScheduleTask = {
        record,
        target,
        involvedSessionIds: involved(actorSessionId, target, []),
        status: 'active',
        createdAt,
        updatedAt: createdAt,
        deliveryHistory: { records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false },
      };
      await this.store.put(id, task);
      this.emitChanged();
      this.runtime?.requestDrive();
      return this.entry(task);
    });
  }

  /** Read one page of tasks without activating target sessions. */
  async list(request: ScheduleListRequest = {}): Promise<ScheduleListResult> {
    const { limit, offset } = resolveListPage(request);
    const items = this.entries()
      .filter((entry) => request.active === undefined || (entry.status === 'active') === request.active);
    const page = items.slice(offset, offset + limit);
    return { items: page, shown: page.length, total: items.length, limit, offset };
  }

  /** Read every task without a page bound or session activation. */
  catalog(): ScheduleCatalogEntry[] {
    return this.entries();
  }

  /** Read one task without activating its target sessions. */
  async view(request: ScheduleViewRequest): Promise<ScheduleViewResult> {
    const task = this.store.get(request.id);
    return task === undefined ? { id: request.id, code: 'schedule_not_found' } : this.entry(task);
  }

  /** Read one page of saved deliveries without activating a target session. */
  async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new ScheduleInputError('invalid_rule', 'Delivery history limit must be a safe integer from 1 through 100.');
    }
    const task = this.store.get(request.id);
    return task === undefined
      ? { id: request.id, code: 'schedule_not_found' }
      : deliveryHistoryPage(task, request, this.limits.retention);
  }

  /** Deliver one task now without consuming or moving its scheduled occurrence. */
  async run(request: ScheduleRunRequest, signal?: AbortSignal): Promise<ScheduleRunResult> {
    if (this.runtime === undefined) throw new Error('Schedule runtime is unavailable');
    const result = await this.runtime.runNow(request.id, signal);
    if (result === undefined) return { id: request.id, code: 'schedule_not_found' };
    return result.admitted ? this.entry(result.task) : { id: request.id, code: 'schedule_execution_pending' };
  }

  /** Delete every ended task, leaving active tasks armed. */
  async deleteInactive(): Promise<ScheduleDeleteInactiveResult> {
    return this.serialize<ScheduleDeleteInactiveResult>(async () => {
      const ended = this.store.entries()
        .filter(([, task]) => task.status === 'ended')
        .map(([id]) => id);
      const deleted = await this.store.deleteMany(ended);
      if (deleted > 0) this.emitChanged();
      return { deleted };
    });
  }

  /**
   * Update or delete one task and record the acting agent's session as involved.
   */
  async edit(
    request: ScheduleEditRequest,
    actorSessionId?: string,
    signal?: AbortSignal,
  ): Promise<ScheduleEditResult> {
    if (request.action === 'update' && Object.keys(request.patch).length === 0) {
      throw new ScheduleInputError('invalid_rule', 'An update patch requires at least one field.');
    }
    const target = request.action === 'update' && request.patch.target !== undefined
      ? await this.resolveTarget(request.patch.target, signal)
      : undefined;
    return this.serialize<ScheduleEditResult>(async () => {
      signal?.throwIfAborted();
      const current = this.store.get(request.id);
      if (current === undefined) return { id: request.id, code: 'schedule_not_found' } as ScheduleNotFoundResult;
      if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== (current.updatedAt ?? null)) {
        return { id: request.id, code: 'schedule_conflict' };
      }
      if (request.action === 'delete') {
        await this.store.delete(request.id);
        this.emitChanged();
        this.runtime?.requestDrive();
        return { id: request.id, deleted: true };
      }
      const effectiveTarget = target ?? current.target;
      if (target !== undefined || request.patch.timing !== undefined || request.patch.active === true) {
        await this.validateTarget(effectiveTarget, signal);
        signal?.throwIfAborted();
      }
      const task = revisedTask(current, request.patch, target, actorSessionId, Date.now());
      await this.store.put(request.id, task);
      this.emitChanged();
      this.runtime?.requestDrive();
      return this.entry(task);
    });
  }

  private emitChanged(): void {
    // No live observers yet: the web client polls the catalog when the page is
    // open, and agent tools read state synchronously.
  }

  /**
   * Resolve a requested destination without activating a session.
   */
  private async resolveTarget(request: ScheduleTargetRequest, signal?: AbortSignal): Promise<ScheduleTarget> {
    switch (request.kind) {
      case 'session': {
        const target: ScheduleTarget = { kind: 'session', sessionId: request.sessionId };
        await this.validateTarget(target, signal);
        return target;
      }
      case 'new_once':
        return {
          kind: 'new_once',
          sessionId: `session-${randomUUID()}`,
          create: createSpec(request.create),
        };
      case 'new':
        return { kind: 'new', create: createSpec(request.create) };
    }
  }

  /** Check delivery prerequisites without activating a session; repeated inside the mutation FIFO. */
  private async validateTarget(target: ScheduleTarget, signal?: AbortSignal): Promise<void> {
    if (target.kind === 'new') return;
    if (target.kind === 'new_once') return;
    signal?.throwIfAborted();
    const result = await this.host.validateSession(target.sessionId);
    if (!result.ok) {
      throw new ScheduleInputError(
        result.code === 'subagent_session' ? 'subagent_session' : 'invalid_rule',
        result.code === 'subagent_session' ? SUBAGENT_SESSION_REFUSAL : result.message,
      );
    }
  }

  /** Every stored task as a catalog entry, in {@link compareEntries} order. */
  private entries(): ScheduleCatalogEntry[] {
    return this.store.entries().map(([, task]) => this.entry(task)).sort(compareEntries);
  }

  private entry(task: ScheduleTask): ScheduleCatalogEntry {
    const floorEnd = this.runtime?.deliveryFloorEnd(task);
    return {
      ...task.record,
      target: task.target,
      involvedSessionIds: [...task.involvedSessionIds],
      status: task.status,
      ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
      ...(task.updatedAt === undefined ? {} : { updatedAt: task.updatedAt }),
      ...(this.runtime?.isExecutionActive(task.record.id) === true ? { executionActive: true as const } : {}),
      ...(floorEnd === undefined ? {} : { deliveryFloorEndsAt: new Date(floorEnd).toISOString() }),
      ...(task.lastDelivery === undefined ? {} : { lastDelivery: task.lastDelivery }),
    };
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Schedule service is stopping'));
    const pending = this.chain.then(work);
    this.chain = pending.catch(() => undefined);
    return pending;
  }
}
