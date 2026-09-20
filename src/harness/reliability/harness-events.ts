/**
 * Harness 层循环事件
 *
 * `runAgentWithReliability()` 在 Loop 协议事件之外追加的用户可见事件。
 * 与 `AgentLoopEvent` 分离：Layer 0 词表保持协议纯净，Harness 语义不反向污染 Loop。
 */

import type { AgentLoopEvent } from '../../loop/types.js';

/** 资源 hard 总闸触发 */
export type BudgetExceededEvent = {
  type: 'budget_exceeded';
  timestamp: number;
  data: { reason: 'tokens' | 'wall_clock' | 'iteration' | 'tool_calls'; report?: unknown };
};

/** RunGuard 判定 recover */
export type RunGuardRecoveredEvent = {
  type: 'run_guard_recovered';
  timestamp: number;
  data: { reason: string; actions: string[] };
};

/** RunGuard 判定 stop */
export type RunGuardStoppedEvent = {
  type: 'run_guard_stopped';
  timestamp: number;
  data: { reason: string; userMessage?: string };
};

/** Observer：RunMetricsCollector 快照（run 结束时） */
export type RunGuardMetricsEvent = {
  type: 'run_guard_metrics';
  timestamp: number;
  data: {
    sessionId?: string;
    agentId?: string;
    iteration: number;
    totalToolCalls: number;
    totalTokens: number;
    elapsedMs: number;
    consecutiveErrors: number;
    consecutiveSameTool: number;
    noopStreak: number;
    hasProgress: boolean;
    uniqueTools: string[];
    recentTools: Array<{ name: string; success: boolean }>;
    recoveryCount: number;
  };
};

/** SecurityGuard 拦截工具调用（Observer security 通道） */
export type SecurityBlockedEvent = {
  type: 'security_blocked';
  timestamp: number;
  data: {
    sessionId?: string;
    agentId?: string;
    reason?: string;
    toolName?: string;
    action?: string;
    severity?: string;
    violations?: Array<{ type?: string; severity?: string; description?: string }>;
  };
};

/** Harness 层扩展事件 */
export type HarnessLoopExtension =
  | BudgetExceededEvent
  | RunGuardRecoveredEvent
  | RunGuardStoppedEvent
  | RunGuardMetricsEvent
  | SecurityBlockedEvent;

/** reliability 包装后的完整事件流 */
export type HarnessLoopEvent = AgentLoopEvent | HarnessLoopExtension;
