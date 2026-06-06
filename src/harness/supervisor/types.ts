/**
 * AgentSupervisor 类型定义
 *
 * 定义 Supervisor 运行时所需的所有类型。
 */

import type { EventBusAgentEvent as AgentEvent } from '../../core/index.js';

// ── Agent 状态 ──

/** Agent 运行时状态 */
export interface AgentState {
  /** Agent ID */
  readonly agentId: string;
  /** 当前活跃的计划 */
  activePlan: Plan | null;
  /** 最近的执行记录 */
  recentExecutions: ExecutionRecord[];
  /** 累积的统计 */
  stats: AgentStats;
  /** 扩展状态 */
  metadata: Record<string, unknown>;
}

/** Agent 统计 */
export interface AgentStats {
  totalEvents: number;
  totalExecutions: number;
  totalErrors: number;
  totalTokensUsed: number;
  startTime: number;
  lastActiveTime: number;
}

// ── 计划 ──

/** 计划 */
export interface Plan {
  /** 计划 ID */
  id: string;
  /** 目标描述 */
  goal: string;
  /** 步骤列表 */
  steps: PlanStep[];
  /** 当前执行到的步骤索引 */
  currentStepIndex: number;
  /** 计划状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  /** 创建时间 */
  createdAt: number;
  /** 完成时间 */
  completedAt?: number;
}

/** 计划步骤 */
export interface PlanStep {
  /** 步骤 ID */
  id: string;
  /** 步骤描述 */
  description: string;
  /** 步骤类型 */
  type: 'llm_call' | 'tool_call' | 'spawn_agent' | 'wait' | 'custom';
  /** 步骤参数 */
  params: Record<string, unknown>;
  /** 步骤状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  /** 步骤结果 */
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

// ── 执行记录 ──

/** 执行记录 */
export interface ExecutionRecord {
  /** 事件/触发源 */
  trigger: AgentEvent;
  /** 执行的计划（如果有） */
  plan?: Plan;
  /** 执行结果 */
  result: StepResult;
  /** 执行时间 */
  timestamp: number;
}

// ── Planner 接口 ──

/**
 * Planner — 规划器接口
 *
 * 决定 Agent 在给定事件和状态下应该做什么。
 * Harness 层可以实现多种 Planner：LLM 驱动、规则驱动、混合。
 */
export interface Planner {
  /** 规划器名称 */
  readonly name: string;

  /**
   * 分析事件，决定下一步行动
   *
   * @param events - 待处理的事件
   * @param state - 当前 Agent 状态
   * @returns 计划（可以是空计划 = "什么都不做"）
   */
  decide(events: AgentEvent[], state: AgentState): Promise<Plan>;

  /**
   * 将目标分解为可执行步骤
   *
   * @param goal - 目标描述
   * @param state - 当前 Agent 状态
   * @returns 计划
   */
  decompose(goal: string, state: AgentState): Promise<Plan>;
}

// ── Reflector 接口 ──

/**
 * Reflector — 反思器接口
 *
 * 评估执行质量，识别模式，提取经验教训。
 * 可选组件，不实现时 Agent 仍能正常运行。
 */
export interface Reflector {
  /** 反思器名称 */
  readonly name: string;

  /**
   * 评估一次执行的质量
   *
   * @param record - 执行记录
   * @returns 评估结果
   */
  assess(record: ExecutionRecord): Promise<Assessment>;

  /**
   * 从多次执行中识别模式
   *
   * @param history - 最近的执行记录
   * @returns 识别到的模式
   */
  detectPatterns(history: ExecutionRecord[]): Promise<Pattern[]>;
}

/** 评估结果 */
export interface Assessment {
  /** 质量评分 0-1 */
  quality: number;
  /** 是否成功 */
  success: boolean;
  /** 问题描述（如果有） */
  issues?: string[];
  /** 改进建议 */
  suggestions?: string[];
}

/** 识别到的模式 */
export interface Pattern {
  /** 模式类型 */
  type: 'recurring_error' | 'performance_degradation' | 'user_preference' | 'efficiency';
  /** 模式描述 */
  description: string;
  /** 置信度 0-1 */
  confidence: number;
  /** 相关的执行记录 IDs */
  relatedExecutionIds: string[];
}

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
