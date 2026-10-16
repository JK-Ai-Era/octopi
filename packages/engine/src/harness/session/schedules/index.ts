/**
 * Session schedules — Agent 自发起定时（timer_* / schedule_*）
 *
 * 见 arch/session-schedules.md。
 */

export {
  ACTIVE_SCHEDULE_STATUSES,
  TERMINAL_SCHEDULE_STATUSES,
  SCHEDULE_TRANSITIONS,
  assertTransition,
  canTransition,
  isScheduleActiveish,
  parseDurationMs,
  type ScheduleCatchUp,
  type ScheduleDelivery,
  type SessionSchedule,
  type SessionScheduleCreateInput,
  type SessionScheduleKind,
  type SessionSchedulePayload,
  type SessionScheduleStatus,
} from './types.js';

export {
  SessionScheduleStore,
  buildScheduleRecord,
  type SessionScheduleStoreOptions,
} from './store.js';

export {
  SessionScheduleService,
  parseFireAt,
  scheduleIsOpen,
  type SessionScheduleServiceOptions,
  type SessionScheduleWakeup,
  type SessionScheduleNotify,
  type ScheduleTimeSpec,
} from './service.js';

export { renderSessionSchedulesInjection } from './render.js';

export {
  createSessionScheduleTools,
  createTimerWaitTool,
  createTimerCancelTool,
  createScheduleSetTool,
  createScheduleUpdateTool,
  createScheduleListTool,
  createScheduleCancelTool,
  createSchedulePauseTool,
  createScheduleResumeTool,
  type TimerWaitToolOptions,
} from './tools.js';
