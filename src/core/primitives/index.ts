/**
 * Core 基础设施原语
 *
 * 机制性组件：EventBus（开放信封）、StateMachine（泛型）。
 * 产品事件词表在 harness/events；Session 状态策略在 harness/session-state-machine.ts。
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
