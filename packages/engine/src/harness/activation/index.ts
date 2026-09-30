/**
 * agent-runtime 领域统一导出
 *
 * 激活宿主：Trigger → 0..N 次受监督的 Run。
 * 不规划业务、不检测跑飞、不实现协议 Source（Integration 适配）。
 * 设计：arch/agent-runtime.md
 */

export { AgentRuntime } from './runtime.js';
export type { AgentRuntimeConfig } from './runtime.js';
export { ExplicitRouter } from './router.js';
export type { ExplicitRouterConfig } from './router.js';
export { SessionRunnerDispatcher } from './dispatcher.js';
export type { SessionRunnerDispatcherOptions } from './dispatcher.js';
export { CoalesceBuffer } from './coalesce.js';
export type { CoalesceOptions, CoalescePushResult } from './coalesce.js';
export { compileMessages, buildRunRequest, resolveSessionId } from './compiler.js';
export { RuntimeEvents } from './types.js';
export {
  ScheduleSource,
  EscalateBridge,
  AgentSignalSource,
  emitEscalate,
  emitAgentSignal,
  ESCALATE_EVENT_TYPE,
  SIGNAL_ESCALATE_EVENT_TYPE,
  AGENT_SIGNAL_EVENT_TYPE,
} from './sources/index.js';
export type {
  ScheduleJob,
  ScheduleSourceConfig,
  EscalateBridgeConfig,
  AgentSignal,
  AgentSignalSourceConfig,
} from './sources/index.js';
export type {
  Trigger,
  TriggerType,
  TriggerPayload,
  TriggerSource,
  RunRequest,
  RunDispatcher,
  RouteTarget,
  AgentRouter,
  RuntimeAgent,
  DispatchResult,
  FanoutDispatchResult,
  RuntimeEvent,
  RuntimeEventType,
  RuntimeEventListener,
} from './types.js';
