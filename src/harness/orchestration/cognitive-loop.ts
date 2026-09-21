/**
 * Cognitive loop contracts — Plan / Planner / Reflector
 *
 * @layer harness/orchestration — orchestration 产品契约，非 Kernel。
 */

import type { AgentEvent } from '../../core/primitives/event-bus.js';

// ── Agent 状态 ──

/** Agent 运行时状态 */
export interface AgentState {
  readonly agentId: string;
  activePlan: Plan | null;
  recentExecutions: ExecutionRecord[];
  stats: AgentStats;
  metadata: Record<string, unknown>;
}

/** Agent 统计 */
export interface AgentStats {
  totalEvents: number;
  totalExecutions: number;
  totalErrors: number;
  /** 诊断：名义 token 总量（Σ nominal） */
  nominalTokensUsed: number;
  startTime: number;
  lastActiveTime: number;
}

// ── 计划 ──

/** 计划 */
export interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  currentStepIndex: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  completedAt?: number;
}

/** 计划步骤 */
export interface PlanStep {
  id: string;
  description: string;
  type: 'llm_call' | 'tool_call' | 'spawn_agent' | 'wait' | 'custom';
  params: Record<string, unknown>;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  result?: StepResult;
}

/** 步骤结果 */
export interface StepResult {
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
  tokenUsage?: { input: number; output: number };
}

/** 执行记录 */
export interface ExecutionRecord {
  trigger: AgentEvent;
  plan?: Plan;
  result: StepResult;
  timestamp: number;
}

// ── Planner ──

/**
 * Planner — 规划器接口
 *
 * 决定 Agent 在给定事件和状态下应该做什么。
 */
export interface Planner {
  readonly name: string;
  decide(events: AgentEvent[], state: AgentState): Promise<Plan>;
  decompose(goal: string, state: AgentState): Promise<Plan>;
}

// ── Reflector ──

/**
 * Reflector — 反思器接口
 */
export interface Reflector {
  readonly name: string;
  assess(record: ExecutionRecord): Promise<Assessment>;
  detectPatterns(history: ExecutionRecord[]): Promise<Pattern[]>;
}

/** 评估结果 */
export interface Assessment {
  quality: number;
  success: boolean;
  issues?: string[];
  suggestions?: string[];
}

/** 识别到的模式 */
export interface Pattern {
  type: 'recurring_error' | 'performance_degradation' | 'user_preference' | 'efficiency';
  description: string;
  confidence: number;
  relatedExecutionIds: string[];
}
