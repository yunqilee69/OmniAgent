/**
 * Host timer over standalone tasks; target session activation is a delivery
 * operation provided by the host composition.
 * @module @omniagent/core/schedule/runtime
 */

import { randomUUID } from 'node:crypto';
import {
  isRecurringScheduleRecord,
  MIN_EVERY_INTERVAL_SECONDS,
  renderRecurringReminderBatchFraming,
  renderReminderFraming,
  resolveRecurringOccurrence,
} from './domain.ts';
import type { RecurringOccurrence } from './domain.ts';
import { appendDelivery } from './delivery-history.ts';
import type { ScheduleTask } from './store.ts';
import type {
  DeliveryRetentionBounds,
  ScheduleDeliveryReceipt,
  ScheduleId,
  ScheduleTarget,
} from './types.ts';

/** Largest delay Node timers represent without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Fixed per-task delivery floor interval, timed or manual, of a target other than `new`. */
export const MIN_DELIVERY_INTERVAL_MS = MIN_EVERY_INTERVAL_SECONDS * 1_000;

/** Resolved deployment limits of one runtime. */
export interface ScheduleRuntimeLimits {
  readonly retention: DeliveryRetentionBounds;
  readonly newSessionIntervalMs: number;
}

/** One delivery request handed to the host composition. */
export interface ScheduleDeliveryRequest {
  readonly taskId: ScheduleId;
  readonly title: string;
  readonly target: ScheduleTarget;
  /** Model-visible reminder text, framed with the schedule identity and occurrence. */
  readonly text: string;
  readonly occurrenceAt: string;
}

/** Target session chosen or created for one delivery. */
export interface ScheduleDeliveredTarget {
  readonly sessionId: string;
  readonly messageId?: string;
  readonly deliveredAt?: string;
}

/** Host composition that validates and delivers into OmniAgent sessions. */
export interface ScheduleDeliveryHost {
  /** Validate an existing delivery target without activating it. */
  validateSession(sessionId: string): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly code: 'invalid_rule' | 'subagent_session'; readonly message: string }
  >;
  /** Deliver one framed reminder, creating the target session when the target asks for it. */
  deliver(request: ScheduleDeliveryRequest): Promise<ScheduleDeliveredTarget>;
}

/** Owns at most one timer across recomputations; delivery and management share the serialized operation. */
export class ScheduleRuntime {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private readonly executing = new Set<ScheduleId>();
  private stopping = false;
  private requested = false;

  constructor(
    private readonly tasks: () => readonly ScheduleTask[],
    private readonly transact: <T>(work: () => Promise<T>) => Promise<T>,
    private readonly commit: (task: ScheduleTask) => Promise<void>,
    private readonly changed: () => void,
    private readonly limits: ScheduleRuntimeLimits,
    private readonly host: ScheduleDeliveryHost,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  /** Recompute the nearest obligation after startup or a durable change. */
  requestDrive(): void {
    if (this.stopping) return;
    this.requested = true;
    this.clearTimer();
    if (this.running !== undefined) return;
    const run = (async () => {
      while (this.requested && !this.stopping) {
        this.requested = false;
        await this.transact(async () => { await this.drive(); });
      }
    })();
    this.running = run;
    void run.catch((error: unknown) => {
      this.log(`schedule: dispatch stopped: ${String(error)}`);
    }).finally(() => {
      this.running = undefined;
      if (this.requested && !this.stopping) this.requestDrive();
    });
  }

  /** Stop the timer and drain an accepted delivery before storage closes. */
  async dispose(): Promise<void> {
    this.stopping = true;
    this.clearTimer();
    await this.running?.catch(() => undefined);
  }

  /** Queue one manual execution without consuming or moving its scheduled occurrence. */
  async runNow(id: ScheduleId, signal?: AbortSignal): Promise<
    { readonly task: ScheduleTask; readonly admitted: boolean } | undefined
  > {
    return this.transact(async () => {
      signal?.throwIfAborted();
      const task = this.tasks().find((candidate) => candidate.record.id === id);
      if (task === undefined) return undefined;
      if (this.executing.has(id) || this.nextAdmissionAt(task) > Date.now()) {
        return { task, admitted: false };
      }
      const occurrenceAt = new Date(Date.now()).toISOString();
      this.executing.add(id);
      try {
        const sent = await this.host.deliver({
          taskId: id,
          title: task.record.title,
          target: task.target,
          text: renderReminderFraming({ ...task.record, scheduledAt: occurrenceAt }),
          occurrenceAt,
        });
        const delivered = this.delivered(task, this.receipt(occurrenceAt, sent, task.target));
        await this.commit(delivered);
        return { task: delivered, admitted: true };
      } finally {
        this.executing.delete(id);
        this.changed();
        this.requestDrive();
      }
    });
  }

  /** Whether a queued or running execution holds this task's slot. */
  isExecutionActive(id: ScheduleId): boolean {
    return this.executing.has(id);
  }

  /** End of this task's current minimum delivery interval. */
  deliveryFloorEnd(task: ScheduleTask): number | undefined {
    const end = this.nextAdmissionAt(task);
    return end > Date.now() ? end : undefined;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async drive(): Promise<void> {
    this.clearTimer();
    const failed = new Set<ScheduleId>();
    const handled = new Set<ScheduleId>();
    const scanNow = Date.now();
    const due = this.tasks().filter((task) => task.status === 'active'
      && !this.executing.has(task.record.id)
      && Date.parse(task.record.scheduledAt) <= scanNow);
    const groups = groupDue(due);
    for (const group of groups) {
      if (this.stopping) return;
      if (handled.has(group[0]!.record.id)) continue;
      for (const member of group) handled.add(member.record.id);
      for (const id of await this.deliverDue(group, group.length > 1)) failed.add(id);
    }
    if (this.stopping) return;
    const next = this.tasks().filter((task) => task.status === 'active'
      && !failed.has(task.record.id)
      && !this.executing.has(task.record.id))
      .reduce<number | undefined>((at, task) => {
        const target = Math.max(Date.parse(task.record.scheduledAt), this.nextAdmissionAt(task));
        return at === undefined ? target : Math.min(at, target);
      }, undefined);
    if (next !== undefined) {
      this.timer = setTimeout(() => { this.timer = undefined; this.requestDrive(); },
        Math.max(0, Math.min(next - Date.now(), MAX_TIMER_DELAY_MS)));
      this.timer.unref();
    }
  }

  /** Deliver one due group in one message and advance each committed member. */
  private async deliverDue(group: readonly ScheduleTask[], batch: boolean): Promise<readonly ScheduleId[]> {
    let admitted = group;
    const committed = new Set<ScheduleId>();
    try {
      const candidates = group.filter((member) => this.nextAdmissionAt(member) <= Date.now());
      const checkedAt = Date.now();
      admitted = candidates.filter((member) => Date.parse(member.record.scheduledAt) <= checkedAt);
      const first = admitted[0];
      if (first === undefined) return [];
      const now = Date.now();
      admitted = admitted.filter((member) => Date.parse(member.record.scheduledAt) <= now);
      const deliveries = admitted.map((task) => ({
        task,
        occurrence: isRecurringScheduleRecord(task.record)
          ? resolveRecurringOccurrence(task.record, now)
          : { occurrenceAt: task.record.scheduledAt },
      }));
      const single = deliveries[0];
      if (single === undefined) return [];
      const text = batch
        ? renderRecurringReminderBatchFraming(deliveries.map(({ task, occurrence }) => ({
          record: task.record, occurrenceAt: occurrence.occurrenceAt,
        })))
        : renderReminderFraming({ ...single.task.record, scheduledAt: single.occurrence.occurrenceAt });
      const held = deliveries.map(({ task }) => task.record.id);
      for (const id of held) this.executing.add(id);
      try {
        const sent = await this.host.deliver({
          taskId: first.record.id,
          title: first.record.title,
          target: first.target,
          text,
          occurrenceAt: single.occurrence.occurrenceAt,
        });
        for (const { task, occurrence } of deliveries) {
          await this.commit(this.advanced(task, occurrence, this.receipt(occurrence.occurrenceAt, sent, task.target)));
          committed.add(task.record.id);
        }
      } finally {
        for (const id of held) this.executing.delete(id);
      }
      return [];
    } catch (error: unknown) {
      const pending = admitted.filter((member) => !committed.has(member.record.id));
      const failedAt = Date.now();
      const ids = pending.map((member) => member.record.id);
      this.log(`schedule: reminders ${JSON.stringify(ids)} were not delivered: ${String(error)}`);
      return pending.filter((member) => Date.parse(member.record.scheduledAt) <= failedAt).map((member) => member.record.id);
    }
  }

  /** Earliest wall-clock instant at which this task may admit another delivery. */
  private nextAdmissionAt(task: ScheduleTask): number {
    const receipt = task.lastDelivery;
    if (receipt === undefined) return Number.NEGATIVE_INFINITY;
    const interval = task.target.kind === 'new' ? this.limits.newSessionIntervalMs : MIN_DELIVERY_INTERVAL_MS;
    const occurrence = Date.parse(receipt.scheduledAt);
    const anchor = Date.parse(task.record.scheduledAt) - occurrence >= interval
      ? occurrence
      : Date.parse(receipt.deliveredAt);
    return anchor + interval;
  }

  private receipt(
    scheduledAt: string,
    sent: ScheduleDeliveredTarget,
    _target: ScheduleTarget,
  ): ScheduleDeliveryReceipt {
    return {
      scheduledAt,
      deliveredAt: sent.deliveredAt ?? new Date(Date.now()).toISOString(),
      messageId: sent.messageId ?? randomUUID(),
      targetSessionId: sent.sessionId,
    };
  }

  /** Apply one receipt to the target and history while keeping the scheduled occurrence. */
  private delivered(task: ScheduleTask, receipt: ScheduleDeliveryReceipt): ScheduleTask {
    return {
      ...task,
      target: task.target.kind === 'new_once'
        ? { kind: 'session', sessionId: receipt.targetSessionId }
        : task.target,
      involvedSessionIds: task.target.kind === 'new'
        ? task.involvedSessionIds
        : [...new Set([...task.involvedSessionIds, receipt.targetSessionId])],
      updatedAt: new Date(Math.max(
        Date.parse(receipt.deliveredAt),
        task.updatedAt === undefined ? Date.parse(receipt.deliveredAt) : Date.parse(task.updatedAt) + 1,
      )).toISOString(),
      pendingDelivery: undefined,
      ...appendDelivery(task, receipt, this.limits.retention),
    };
  }

  /** Apply one timed receipt and advance the rule that owns dispatch to its next target. */
  private advanced(task: ScheduleTask, occurrence: RecurringOccurrence, receipt: ScheduleDeliveryReceipt): ScheduleTask {
    const scheduledAt = occurrence.nextScheduledAt ?? occurrence.occurrenceAt;
    return {
      ...this.delivered(task, receipt),
      record: { ...task.record, scheduledAt },
      status: occurrence.nextScheduledAt === undefined ? 'ended' : 'active',
    };
  }
}

/**
 * Group due tasks that share one recurring existing-session target so they are
 * delivered in one message, as DSH does.
 */
function groupDue(due: readonly ScheduleTask[]): ScheduleTask[][] {
  const groups: ScheduleTask[][] = [];
  const bySession = new Map<string, ScheduleTask[]>();
  for (const task of due) {
    if (task.target.kind === 'session' && isRecurringScheduleRecord(task.record)) {
      const group = bySession.get(task.target.sessionId);
      if (group !== undefined) group.push(task);
      else bySession.set(task.target.sessionId, [task]);
    } else {
      groups.push([task]);
    }
  }
  for (const group of bySession.values()) groups.push(group);
  return groups;
}
