/**
 * Durable and model-facing Schedule value types.
 *
 * Ported from DSH's `@deepseek-ai/dsh-schedule/types` without a plugin
 * runtime, branded ids, or session-event compatibility types.
 * @module @omniagent/core/schedule/types
 */

/** Stable globally unique schedule identity. */
export type ScheduleId = string;

/** Durable one-shot reminder created from a positive delay. */
export interface AfterScheduleRecord {
  readonly id: ScheduleId;
  readonly kind: 'after';
  readonly title: string;
  readonly prompt: string;
  readonly afterSeconds: number;
  readonly scheduledAt: string;
}

/** Durable one-shot reminder created from an absolute instant. */
export interface AtScheduleRecord {
  readonly id: ScheduleId;
  readonly kind: 'at';
  readonly title: string;
  readonly prompt: string;
  readonly scheduledAt: string;
}

/** Durable fixed-rate reminder aligned to creation or its most recent interval edit. */
export interface EveryScheduleRecord {
  readonly id: ScheduleId;
  readonly kind: 'every';
  readonly title: string;
  readonly prompt: string;
  readonly everySeconds: number;
  readonly scheduledAt: string;
}

/** Durable daily wall-clock reminder. */
export interface DailyScheduleRecord {
  readonly id: ScheduleId;
  readonly kind: 'daily';
  readonly title: string;
  readonly prompt: string;
  /** Local time normalized to HH:mm:ss.SSS. */
  readonly time: string;
  readonly timeZone: string;
  readonly scheduledAt: string;
}

/** Durable weekly wall-clock reminder. */
export interface WeeklyScheduleRecord {
  readonly id: ScheduleId;
  readonly kind: 'weekly';
  readonly title: string;
  readonly prompt: string;
  readonly time: string;
  readonly timeZone: string;
  /** Unique ascending ISO weekdays, Monday 1 through Sunday 7. */
  readonly weekdays: number[];
  readonly scheduledAt: string;
}

/** Durable cron wall-clock reminder. */
export interface CronScheduleRecord {
  readonly id: ScheduleId;
  readonly kind: 'cron';
  readonly title: string;
  readonly prompt: string;
  readonly expression: string;
  readonly timeZone: string;
  readonly scheduledAt: string;
}

/** RFC 5545 timing with an explicit DTSTART anchor and zone. */
export interface RRuleScheduleRecord {
  readonly id: ScheduleId;
  readonly kind: 'rrule';
  readonly title: string;
  readonly prompt: string;
  readonly rrule: string;
  readonly scheduledAt: string;
}

/** Daily local-time selector accepted by creation and timing edits. */
export interface DailyInput {
  readonly time: string;
  readonly time_zone: string;
}

/** Weekly local-time and weekday selector accepted by creation and timing edits. */
export interface WeeklyInput {
  readonly time: string;
  readonly time_zone: string;
  readonly weekdays: number[];
}

/** Five-field cron selector accepted by creation and timing edits. */
export interface CronInput {
  readonly expression: string;
  readonly time_zone: string;
}

/** Structured local-calendar input accepted by creation and timing edits. */
export interface LocalAtInput {
  readonly date: string;
  readonly time: string;
  readonly time_zone: string;
}

/** Absolute selector accepted by creation and timing edits. */
export type AtInput = string | LocalAtInput;

/** One-shot task variants. */
export type OneShotScheduleRecord = AfterScheduleRecord | AtScheduleRecord;

/** Recurring task variants. */
export type RecurringScheduleRecord =
  | EveryScheduleRecord
  | DailyScheduleRecord
  | WeeklyScheduleRecord
  | CronScheduleRecord
  | RRuleScheduleRecord;

/** Current timing records. */
export type ScheduleRecord = OneShotScheduleRecord | RecurringScheduleRecord;

/** Timing accepted by the shared management API. */
export type ScheduleTiming =
  | { readonly kind: 'after'; readonly after_seconds: number }
  | { readonly kind: 'at'; readonly at: AtInput }
  | { readonly kind: 'every'; readonly every_seconds: number }
  | { readonly kind: 'daily'; readonly daily: DailyInput }
  | { readonly kind: 'weekly'; readonly weekly: WeeklyInput }
  | { readonly kind: 'cron'; readonly cron: CronInput }
  | { readonly kind: 'rrule'; readonly rrule: string };

/** Values used when a target creates a session. */
export interface ScheduleSessionCreateSpec {
  /** Working directory of the created session. */
  readonly cwd?: string;
  /** Agent id of the created session; omission uses `default`. */
  readonly agentPreset?: string;
}

/** Stored delivery destination. */
export type ScheduleTarget =
  | { readonly kind: 'session'; readonly sessionId: string }
  | {
    /** The first delivery creates one session; later deliveries go to it. */
    readonly kind: 'new_once';
    readonly sessionId: string;
    readonly create: ScheduleSessionCreateSpec;
  }
  | { readonly kind: 'new'; readonly create: ScheduleSessionCreateSpec };

/** Destination accepted by create and edit. */
export type ScheduleTargetRequest =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'new_once'; readonly create?: ScheduleSessionCreateSpec }
  | { readonly kind: 'new'; readonly create?: ScheduleSessionCreateSpec };

/** Durable session inbox delivery acknowledgment. */
export interface ScheduleDeliveryReceipt {
  readonly scheduledAt: string;
  readonly deliveredAt: string;
  readonly messageId: string;
  readonly targetSessionId: string;
}

/** Saved inbox delivery with its immutable sent prompt. */
export interface ScheduleDeliveryRecord extends ScheduleDeliveryReceipt {
  readonly prompt?: string;
}

/** Bounded newest-first query over the saved deliveries of one task. */
export interface ScheduleDeliveryHistoryRequest {
  readonly id: ScheduleId;
  readonly limit: number;
  readonly before?: string;
}

/** One newest-first page of saved deliveries. */
export interface ScheduleDeliveryHistoryPage {
  readonly id: ScheduleId;
  readonly records: ScheduleDeliveryRecord[];
  readonly earlierRecordsUnavailable: boolean;
  readonly earlierRecordsPruned: boolean;
  readonly retention: DeliveryRetentionBounds;
  readonly nextBefore?: string;
}

/** Non-mutating miss: the task or the page cursor does not exist. */
export interface ScheduleDeliveryHistoryMiss {
  readonly id: ScheduleId;
  readonly code: 'schedule_not_found' | 'delivery_cursor_not_found';
}

export type ScheduleDeliveryHistoryResult = ScheduleDeliveryHistoryPage | ScheduleDeliveryHistoryMiss;

/** Browser-safe task state. */
export type ScheduleCatalogEntry = ScheduleRecord & {
  readonly target: ScheduleTarget;
  readonly involvedSessionIds: string[];
  readonly status: 'active' | 'paused' | 'ended';
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly executionActive?: true;
  readonly deliveryFloorEndsAt?: string;
  readonly lastDelivery?: ScheduleDeliveryReceipt;
};

/** Task creation request. */
export interface ScheduleCreateRequest {
  readonly title: string;
  readonly prompt: string;
  readonly timing: ScheduleTiming;
  readonly target?: ScheduleTargetRequest;
}

/** Task list request. */
export interface ScheduleListRequest {
  readonly active?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

/** One page of the task list. */
export interface ScheduleListResult {
  readonly items: ScheduleCatalogEntry[];
  readonly shown: number;
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** Read one task by identity. */
export interface ScheduleViewRequest {
  readonly id: ScheduleId;
}

/** Non-mutating miss for an unknown task identity. */
export interface ScheduleNotFoundResult {
  readonly id: ScheduleId;
  readonly code: 'schedule_not_found';
}

export type ScheduleViewResult = ScheduleCatalogEntry | ScheduleNotFoundResult;

/** Fields changed together by one atomic update. */
export interface SchedulePatch {
  readonly title?: string;
  readonly prompt?: string;
  readonly timing?: ScheduleTiming;
  readonly target?: ScheduleTargetRequest;
  readonly active?: boolean;
}

/** One closed edit operation. */
export type ScheduleEditRequest =
  | {
    readonly id: ScheduleId;
    readonly action: 'update';
    readonly patch: SchedulePatch;
    readonly expectedUpdatedAt?: string | null;
  }
  | {
    readonly id: ScheduleId;
    readonly action: 'delete';
    readonly expectedUpdatedAt?: string | null;
  };

/** Non-mutating refusal: the stored task changed after the editor read it. */
export interface ScheduleConflictResult {
  readonly id: ScheduleId;
  readonly code: 'schedule_conflict';
}

/** Deletion outcome. */
export type ScheduleDeleteResult =
  | { readonly id: ScheduleId; readonly deleted: true }
  | { readonly id: ScheduleId; readonly deleted: false; readonly code: 'schedule_not_found' };

/** Updated task state, a completed deletion, or a non-mutating miss or conflict. */
export type ScheduleEditResult =
  | ScheduleCatalogEntry
  | Extract<ScheduleDeleteResult, { readonly deleted: true }>
  | ScheduleNotFoundResult
  | ScheduleConflictResult;

/** Manual execution request. */
export interface ScheduleRunRequest {
  readonly id: ScheduleId;
}

/** Non-mutating refusal: one execution of this task already owns its admission slot. */
export interface ScheduleExecutionPendingResult {
  readonly id: ScheduleId;
  readonly code: 'schedule_execution_pending';
}

export type ScheduleRunResult = ScheduleCatalogEntry | ScheduleNotFoundResult | ScheduleExecutionPendingResult;

/** Successful Host-wide removal of every ended task. */
export interface ScheduleDeleteInactiveResult {
  readonly deleted: number;
}

/** Configured limits applied when appending one task's delivery receipt. */
export interface DeliveryRetentionBounds {
  readonly days: number;
  readonly records: number;
}

/** Stable error returned for an empty, over-long, or untrimmed prompt or title. */
export interface InvalidPromptError {
  readonly code: 'invalid_prompt';
  readonly message: string;
}

/** Stable error returned for a missing, conflicting, or unsupported rule selector. */
export interface InvalidSelectorError {
  readonly code: 'invalid_selector';
  readonly message: string;
}

/** Stable error returned for an invalid rule or management argument. */
export interface InvalidRuleError {
  readonly code: 'invalid_rule';
  readonly message: string;
}

/** Stable error returned for an invalid or unsupported IANA time zone. */
export interface InvalidTimeZoneError {
  readonly code: 'invalid_time_zone';
  readonly message: string;
}

/** Stable error returned when an absolute target is not strictly future. */
export interface NotFutureError {
  readonly code: 'not_future';
  readonly message: string;
}

/** Stable error returned when the computed instant cannot use a four-digit UTC year. */
export interface TimeOutOfRangeError {
  readonly code: 'time_out_of_range';
  readonly message: string;
}

/** Stable error returned when a fixed-rate or RRULE rule runs more often than supported. */
export interface FrequencyTooHighError {
  readonly code: 'frequency_too_high';
  readonly message: string;
}

/** Stable error returned when the target belongs to subagent routing. */
export interface SubagentSessionError {
  readonly code: 'subagent_session';
  readonly message: string;
}

/** Stable fallback that does not disclose an internal exception. */
export interface InternalScheduleError {
  readonly code: 'internal_error';
  readonly message: string;
}

/** Schedule management error union. */
export type ScheduleToolError =
  | InvalidPromptError
  | InvalidSelectorError
  | InvalidRuleError
  | InvalidTimeZoneError
  | NotFutureError
  | TimeOutOfRangeError
  | FrequencyTooHighError
  | SubagentSessionError
  | InternalScheduleError;

/** Input failure codes. */
export type ScheduleInputErrorCode = Exclude<ScheduleToolError['code'], 'internal_error'>;
