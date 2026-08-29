/**
 * ReliabilityHarness — 可靠性装备接口
 *
 * 定义 runAgentWithReliability() 所需的外部依赖。
 * 实现在 harness/reliability/，由 builder 组装注入。
 *
 * 提取到 Core 层（v0.8.0）：这是跨域契约，不是实现细节。
 * 多个领域（supervisor、multi-agent、distributed）依赖此接口。
 */

import type { SecurityGuard } from './security-guard.js';
import type { ErrorStrategy } from './error-strategy.js';
import type { TaskSupervisor } from './task-supervisor.js';

/** 可靠性装备 — runAgentWithReliability() 的外部依赖 */
export interface ReliabilityHarness {
  /** 可靠性配置（类型由实现方定义，这里用 unknown 保持接口独立） */
  config: unknown;
  /** 安全守卫（可选） */
  security?: SecurityGuard;
  /** 错误策略（可选） */
  errorStrategy?: ErrorStrategy;
  /** 任务监督器（可选） */
  taskSupervisor?: TaskSupervisor;
  /** 当前 agentId（用于检查点） */
  agentId?: string;
  /** 当前 sessionId（用于检查点） */
  sessionId?: string;
}
