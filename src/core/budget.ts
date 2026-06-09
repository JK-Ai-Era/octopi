/**
 * IterationBudget — 资源约束（Core 内置）
 *
 * 职责：强制限制 Agent 循环的资源消耗。
 * 不可绕过，Core 层在每个关键节点检查预算状态。
 *
 * 受限资源：
 * - 迭代次数（每次模型调用算一次迭代）
 * - 工具调用次数
 * - Token 消耗
 * - Wall-clock 时间
 */

import type { EventBus } from './event-bus.js';
import { AgentEvents } from './event-bus.js';

// ── 配置 ──

/** 迭代预算配置 */
export interface IterationBudgetConfig {
  /** 最大循环迭代次数 */
  maxIterations: number;
  /** 最大工具调用次数 */
  maxToolCalls: number;
  /** 最大 token 消耗 */
  maxTokens: number;
  /** 最大 wall-clock 时间（毫秒） */
  maxWallClockMs: number;
}

/** 预算状态 */
export type BudgetStatus = 'ok' | 'iteration_limit' | 'tool_call_limit' | 'token_limit' | 'timeout';

/** 预算消耗报告 */
export interface BudgetReport {
  status: BudgetStatus;
  iterations: number;
  toolCalls: number;
  totalTokens: number;
  elapsedMs: number;
  remaining: {
    iterations: number;
    toolCalls: number;
    tokens: number;
    wallClockMs: number;
  };
}

// ── 默认配置 ──

/** 默认预算配置 */
export const DEFAULT_BUDGET: IterationBudgetConfig = {
  maxIterations: 1000,
  maxToolCalls: 5000,
  maxTokens: 1_000_000,
  maxWallClockMs: 36_000_000, // 10 小时（安全兜底，实际由 TaskSupervisor 控制）
};

// ── 实现 ──

/**
 * IterationBudget 实现
 */
export class IterationBudget {
  private config: IterationBudgetConfig;
  private eventBus: EventBus;
  private iterations = 0;
  private toolCalls = 0;
  private totalTokens = 0;
  private startTime: number;

  constructor(eventBus: EventBus, config?: Partial<IterationBudgetConfig>) {
    this.eventBus = eventBus;
    this.config = { ...DEFAULT_BUDGET, ...config };
    this.startTime = Date.now();
  }

  /**
   * 检查预算状态
   * @returns 'ok' 如果预算充足，否则返回具体限制类型
   */
  check(): BudgetStatus {
    if (this.iterations >= this.config.maxIterations) return 'iteration_limit';
    if (this.toolCalls >= this.config.maxToolCalls) return 'tool_call_limit';
    if (this.totalTokens >= this.config.maxTokens) return 'token_limit';
    if (Date.now() - this.startTime >= this.config.maxWallClockMs) return 'timeout';
    return 'ok';
  }

  /**
   * 检查并发射事件（如果超限）
   * @returns true 如果预算充足，false 如果已超限
   */
  checkAndEmit(): boolean {
    const status = this.check();
    if (status === 'ok') return true;

    this.eventBus.emit({
      type: AgentEvents.BUDGET_EXCEEDED,
      timestamp: Date.now(),
      data: { status, report: this.report() },
    });

    return false;
  }

  /** 记录一次迭代 */
  recordIteration(): void {
    this.iterations++;
  }

  /** 记录一次工具调用 */
  recordToolCall(): void {
    this.toolCalls++;
  }

  /** 消耗 token */
  consumeTokens(tokens: number): void {
    this.totalTokens += tokens;
  }

  /** 获取消耗报告 */
  report(): BudgetReport {
    const elapsedMs = Date.now() - this.startTime;
    return {
      status: this.check(),
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      totalTokens: this.totalTokens,
      elapsedMs,
      remaining: {
        iterations: Math.max(0, this.config.maxIterations - this.iterations),
        toolCalls: Math.max(0, this.config.maxToolCalls - this.toolCalls),
        tokens: Math.max(0, this.config.maxTokens - this.totalTokens),
        wallClockMs: Math.max(0, this.config.maxWallClockMs - elapsedMs),
      },
    };
  }

  /** 获取配置 */
  getConfig(): IterationBudgetConfig {
    return { ...this.config };
  }
}
