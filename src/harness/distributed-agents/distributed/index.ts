/**
 * Distributed Intelligence — Unified Exports
 *
 * 分布式智能架构的所有公共接口统一导出。
 */

// ── Core Types ──
export type {
  AgentInput,
  AgentOutput,
  InterceptOutput,
  ContextOutput,
  NotifyOutput,
  TriggerContext,
  AgentContext,
  TaskSummary,
} from './types.js';

// ── Trigger ──
export type {
  EventTrigger,
  ConditionTrigger,
  ThresholdTrigger,
  MessageTrigger,
  TriggerRule,
  TriggerMatch,
  TriggerEngineConfig,
} from './trigger.js';
export { TriggerEngine, getPriority } from './trigger.js';

// ── InputPolicy ──
export type {
  ContextField,
  InputPolicy,
} from './input-policy.js';
export { buildTaskSummary, buildAgentInput } from './input-policy.js';

// ── OutputPolicy ──
export type {
  ResultInjectionMode,
  OutputPolicy,
  InterceptResult,
  InjectionEntry,
} from './output-policy.js';
export {
  handleIntercept,
  handleReplaceContext,
  handleInjectContext,
  handleNotify,
  InjectionQueue,
} from './output-policy.js';

// ── Execution ──
export type {
  LLMExecution,
  CodeExecution,
  HybridExecution,
  ExecutionMode,
} from './execution.js';

// ── Spec ──
export type { DistributedAgentSpec } from './spec.js';

// ── Security ──
export { NoopSecurityGuard } from './noop-security-guard.js';

// ── AuditTrail ──
export type {
  AuditEntry,
  AuditTrailConfig,
} from './audit-trail.js';
export { AuditTrail } from './audit-trail.js';

// ── Runtime ──
export type {
  SharedDeps,
  AgentRuntimeConfig,
} from './runtime.js';
export { AgentRuntime, sortByPriority } from './runtime.js';
