/**
 * Core 基础设施原语
 *
 * 机制性组件：EventBus、StateMachine、AsyncTask、ProcessModel。
 * 这些是框架的基础设施，不是策略实现。
 */

export { DefaultEventBus, NoopEventBus, ThrottledEventBus, AgentEvents } from './event-bus.js';
export type { EventBus, AgentEvent, EventHandler, Disposable, DefaultEventBusOptions, ThrottleConfig } from './event-bus.js';

export { StateMachine, createSessionStateMachine } from './state-machine.js';
export type { StateTransition, StateMachineConfig } from './state-machine.js';

export { AsyncTask, TaskTimeoutError, TaskCancelledError, spawnTask, TaskEvents } from './async-task.js';
export type { TaskOptions, TaskExecutor } from './async-task.js';

export { ProcessModel, ProcessEvents, spawnProcess } from './process-model.js';
export type { ProcessState, ExitReason, ExitInfo, ProcessOptions, ProcessBody, ProcessContext } from './process-model.js';
