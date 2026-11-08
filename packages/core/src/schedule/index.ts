/**
 * Host-wide scheduled tasks: durable store, timer runtime, shared management
 * service, and the four model-facing tools.
 * @module @omniagent/core/schedule
 */

export type * from './types.ts';
export * from './domain.ts';
export { createScheduleRecord, updateScheduleRecord } from './update.ts';
export { ScheduleService, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from './service.ts';
export type { ScheduleServiceOptions } from './service.ts';
export { ScheduleRuntime, MIN_DELIVERY_INTERVAL_MS, MAX_TIMER_DELAY_MS } from './runtime.ts';
export type {
  ScheduleDeliveredTarget,
  ScheduleDeliveryHost,
  ScheduleDeliveryRequest,
  ScheduleRuntimeLimits,
} from './runtime.ts';
export { ScheduleStore } from './store.ts';
export type { ScheduleTask } from './store.ts';
export {
  createScheduleTools,
  isScheduleToolName,
  renderScheduleToolGuidance,
  SCHEDULE_CREATE_TOOL_NAME,
  SCHEDULE_EDIT_TOOL_NAME,
  SCHEDULE_LIST_TOOL_NAME,
  SCHEDULE_TOOL_GROUP,
  SCHEDULE_VIEW_TOOL_NAME,
} from './tools.ts';
