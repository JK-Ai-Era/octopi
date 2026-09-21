/**
 * Harness 层循环事件
 *
 * `runAgentWithReliability()` 在 Loop 协议事件之外追加的用户可见事件。
 * 与 `AgentLoopEvent` 分离：Layer 0 词表保持协议纯净，Harness 语义不反向污染 Loop。
 */

import type { AgentLoopEvent } from '../../loop/types.js';

// ── P2 BudgetControlEvent 新形状 ──

/** 控制停止指标（区分触发源） */
export type ControlStopMetric = 'context' | 'behavior' | 'policy' | 'security';

/** Policy 单位（P3 完整实现；P2 仅 wall_clock_ms） */
export type PolicyUnit =
  | 'wall_clock_ms'
  | 'cost'
  | 'uncached_input_tokens'
  | 'output_tokens'
  | 'llm_calls'
  | 'tool_effects';

/**
 * BudgetControlEvent — P2 控制梯事件
 *
 * 替代旧的 BudgetExceededEvent，统一事件形状。
 * - usage.advisory: 接近阈值告警（不终止）
 * - budget.wrap_up: 进入 wrap-up 窗口
 * - budget.exceeded: 最终停止
 */
export interface BudgetControlEvent {
  type: 'usage.advisory' | 'budget.wrap_up' | 'budget.exceeded';
  timestamp: number;
  metric: ControlStopMetric;
  unit?: PolicyUnit;
  used?: number;
  hard?: number;
  contextEst?: number;
  contextWindow?: number;
  cacheAware?: boolean;
  userMessage: string;
  resumeHint?: string;
}

/** 资源 hard 总闸触发（P0：无 tokens 轴；wall_clock/iteration/tool_calls） */
export type BudgetExceededEvent = {
  type: 'budget_exceeded';
  timestamp: number;
  data: { reason: 'wall_clock' | 'iteration' | 'tool_calls'; report?: unknown };
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

/** Observer：RunMetricsCollector + UsageLedger 快照（run 结束时） */
export type RunGuardMetricsEvent = {
  type: 'run_guard_metrics';
  timestamp: number;
  data: {
    sessionId?: string;
    agentId?: string;
    iteration: number;
    totalToolCalls: number;
    /** 诊断 nominal Σ（非成本 hard） */
    nominalTotalTokens: number;
    elapsedMs: number;
    consecutiveErrors: number;
    consecutiveSameTool: number;
    noopStreak: number;
    hasProgress: boolean;
    uniqueTools: string[];
    recentTools: Array<{ name: string; success: boolean }>;
    recoveryCount: number;
    /** P1 cache-aware 账本 */
    usageLedger?: import('../accounting/usage-ledger.js').UsageLedgerSnapshot;
    /** P4 session 级账本 */
    sessionLedger?: import('../accounting/session-ledger.js').SessionLedgerSnapshot;
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
  | BudgetControlEvent
  | RunGuardRecoveredEvent
  | RunGuardStoppedEvent
  | RunGuardMetricsEvent
  | SecurityBlockedEvent;

/** reliability 包装后的完整事件流 */
export type HarnessLoopEvent = AgentLoopEvent | HarnessLoopExtension;
