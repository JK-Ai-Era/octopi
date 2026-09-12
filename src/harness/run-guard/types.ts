/**
 * AgentSupervisor 运行时类型
 *
 * Plan / Planner / Reflector 等跨域契约见 core/interfaces/cognitive-loop.ts。
 * 本文件只保留 run-guard 域内的 AgentSupervisor 配置。
 */

import type {
  Planner,
  Reflector,
} from '../../core/interfaces/cognitive-loop.js';

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
} from '../../core/interfaces/cognitive-loop.js';

// ── Supervisor 配置 ──

/** AgentSupervisor 配置 */
export interface SupervisorConfig {
  /** Agent 名称 */
  name?: string;
  /** Agent ID */
  agentId: string;
  /** 规划器 */
  planner: Planner;
  /** 反思器（可选） */
  reflector?: Reflector;
  /** 无事件时的休眠时间（毫秒） */
  idleTimeoutMs?: number;
  /** 最大并发任务数 */
  maxConcurrentTasks?: number;
  /** 最大执行记录数 */
  maxExecutionHistory?: number;
}
