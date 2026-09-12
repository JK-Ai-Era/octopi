/**
 * run-guard 领域统一导出
 *
 * 过程监督：判断单次 run 是否跑飞（continue / recover / stop）。
 * 不读写 Session.tasks，不编排 Workflow。
 */

export { AgentSupervisor, startSupervisor, SupervisorEvents } from './agent-supervisor.js';
export { EventCollector } from './event-collector.js';
export { DefaultRunGuard, createRunGuard } from './default-run-guard.js';
export type { RunGuardConfig } from './default-run-guard.js';
export type {
  Planner,
  Reflector,
  AgentState,
  AgentStats,
  Plan,
  PlanStep,
  StepResult,
  ExecutionRecord,
  Assessment,
  Pattern,
  SupervisorConfig,
} from './types.js';
