/**
 * Core 基础设施原语
 *
 * 机制性组件：EventBus（开放信封）、StateMachine（泛型）、Cron（时间数学）。
 * 产品事件词表在 harness/events；Session 状态策略在 harness/session-state-machine.ts。
 * 点火策略（谁 arm timer、点了干什么）在 harness 各域，不在此层。
 */

export { DefaultEventBus, NoopEventBus, ThrottledEventBus } from './event-bus.js';
export type {
  EventBus,
  AgentEvent,
  EventHandler,
  Disposable,
  DefaultEventBusOptions,
  ThrottleConfig,
} from './event-bus.js';

export { StateMachine } from './state-machine.js';
export type { StateTransition, StateMachineConfig } from './state-machine.js';

export { parseCron, nextFireTime, intervalNext, formatHuman } from './cron.js';
export type {
  CronSpec,
  CronFieldSpec,
  CronParseResult,
  CronParseOk,
  CronParseError,
} from './cron.js';
