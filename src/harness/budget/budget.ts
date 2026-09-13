/**
 * ResourceBudget（演进自 IterationBudget）— 资源 soft/hard 约束
 *
 * 职责：与 RunGuard 组合（非替代）。
 * - hard：token / wall-clock 绝对总闸（iteration/toolCalls 仅显式配置时硬停）
 * - soft：触达不杀；进展良好可静默续租，否则交由 Guard
 *
 * 领域口径：harness 非领域模块，经 ReliabilityHarness 注入。
 */

import type { EventBus } from '../../core/primitives/event-bus.js';
import { AgentEvents } from '../../core/primitives/event-bus.js';

// ── 配置 ──

/** 预算配置（实现侧；JSON 形状见 config.BudgetJsonConfig） */
export interface IterationBudgetConfig {
  /**
   * 最大迭代次数。仅当显式设置时作为硬停。
   * 默认省略：长任务不靠 iteration 卡死；行为跑飞由 RunGuard 负责。
   */
  maxIterations?: number;
  /** 最大工具调用次数。仅当显式设置时作为硬停。 */
  maxToolCalls?: number;
  /** 硬顶：最大 token 数（主轴） */
  maxTokens: number;
  /** 硬顶：最大 wall-clock（毫秒，主轴） */
  maxWallClockMs: number;

  /** soft：token 触达（默认约 hard 的 20%） */
  softTokens?: number;
  /** soft：时间触达（默认约 hard 的 35%） */
  softWallClockMs?: number;

  /** soft 触达且 hasProgress 时自动抬升 soft（默认 true） */
  autoRenewOnProgress?: boolean;
  /** 续租 token 增量（默认 softTokens 的一半） */
  renewGrantTokens?: number;
  /** 续租时间增量（毫秒，默认 softWallClockMs 的一半） */
  renewGrantMs?: number;
  /** 最大续租次数（默认 20） */
  maxRenews?: number;
}

/** 预算状态（兼容旧字符串语义；soft 为新增） */
export type BudgetStatus =
  | 'ok'
  | 'soft'
  | 'iteration_limit'
  | 'tool_call_limit'
  | 'token_limit'
  | 'timeout';

/** 评估结果 */
export interface BudgetEvaluation {
  status: 'ok' | 'soft' | 'hard';
  /** hard/soft 原因 */
  reason?: 'tokens' | 'wall_clock' | 'iteration' | 'tool_calls';
  /** 兼容旧 BudgetStatus */
  legacyStatus: BudgetStatus;
  report: BudgetReport;
}

/** 预算消耗报告 */
export interface BudgetReport {
  status: BudgetStatus;
  iterations: number;
  toolCalls: number;
  totalTokens: number;
  elapsedMs: number;
  renews: number;
  remaining: {
    iterations: number | null;
    toolCalls: number | null;
    tokens: number;
    wallClockMs: number;
  };
  soft: {
    tokens: number;
    wallClockMs: number;
  };
  hard: {
    tokens: number;
    wallClockMs: number;
  };
}

// ── 默认配置 ──

export const DEFAULT_BUDGET: IterationBudgetConfig = {
  // 主轴 hard：偏松，避免误伤长任务；部署可在 octopi.json budget 覆盖
  maxTokens: 2_000_000,
  maxWallClockMs: 6 * 3_600_000, // 6h
  // iteration/toolCalls 默认不硬停
  autoRenewOnProgress: true,
  maxRenews: 20,
};

// ── 实现 ──

/**
 * ResourceBudget
 *
 * 每轮由 runAgentWithReliability 检查；消费 token 须先 consumeTokens。
 */
export class IterationBudget {
  private config: Required<Pick<IterationBudgetConfig, 'maxTokens' | 'maxWallClockMs'>> &
    IterationBudgetConfig & {
      autoRenewOnProgress: boolean;
      maxRenews: number;
    };
  private softTokens: number;
  private softWallClockMs: number;
  private eventBus: EventBus;
  private iterations = 0;
  private toolCalls = 0;
  private totalTokens = 0;
  private renews = 0;
  private startTime: number;

  constructor(eventBus: EventBus, config?: Partial<IterationBudgetConfig>) {
    const merged = { ...DEFAULT_BUDGET, ...config };
    this.config = {
      ...merged,
      autoRenewOnProgress: merged.autoRenewOnProgress ?? true,
      maxRenews: merged.maxRenews ?? 20,
    };
    this.eventBus = eventBus;
    this.softTokens = merged.softTokens ?? Math.floor(merged.maxTokens * 0.2);
    this.softWallClockMs = merged.softWallClockMs ?? Math.floor(merged.maxWallClockMs * 0.35);
    this.startTime = Date.now();
  }

  /** 重置计数（Gateway 长驻每请求调用）；保留配置与续租策略 */
  reset(): void {
    this.iterations = 0;
    this.toolCalls = 0;
    this.totalTokens = 0;
    this.renews = 0;
    this.startTime = Date.now();
    // soft 恢复为配置初值
    this.softTokens = this.config.softTokens ?? Math.floor(this.config.maxTokens * 0.2);
    this.softWallClockMs =
      this.config.softWallClockMs ?? Math.floor(this.config.maxWallClockMs * 0.35);
  }

  /**
   * 仅检查 hard（不触发 soft 续租）。
   * 用于 turn_end 在 hasProgress 尚未更新时的资源总闸。
   */
  checkHardOnly(): { status: 'ok' | 'hard'; reason?: BudgetEvaluation['reason']; report: BudgetReport } {
    const elapsedMs = Date.now() - this.startTime;
    if (this.totalTokens >= this.config.maxTokens) {
      return { status: 'hard', reason: 'tokens', report: this.buildReport('token_limit') };
    }
    if (elapsedMs >= this.config.maxWallClockMs) {
      return { status: 'hard', reason: 'wall_clock', report: this.buildReport('timeout') };
    }
    if (
      this.config.maxIterations !== undefined &&
      this.config.maxIterations > 0 &&
      this.iterations >= this.config.maxIterations
    ) {
      return { status: 'hard', reason: 'iteration', report: this.buildReport('iteration_limit') };
    }
    if (
      this.config.maxToolCalls !== undefined &&
      this.config.maxToolCalls > 0 &&
      this.toolCalls >= this.config.maxToolCalls
    ) {
      return { status: 'hard', reason: 'tool_calls', report: this.buildReport('tool_call_limit') };
    }
    return { status: 'ok', report: this.buildReport('ok') };
  }

  /**
   * 评估预算
   *
   * @param hasProgress - 当前是否有实质进展（用于 soft 续租）
   */
  evaluate(hasProgress = true): BudgetEvaluation {
    const elapsedMs = Date.now() - this.startTime;

    // hard
    if (this.totalTokens >= this.config.maxTokens) {
      return this.finish('hard', 'tokens', 'token_limit');
    }
    if (elapsedMs >= this.config.maxWallClockMs) {
      return this.finish('hard', 'wall_clock', 'timeout');
    }
    if (
      this.config.maxIterations !== undefined &&
      this.config.maxIterations > 0 &&
      this.iterations >= this.config.maxIterations
    ) {
      return this.finish('hard', 'iteration', 'iteration_limit');
    }
    if (
      this.config.maxToolCalls !== undefined &&
      this.config.maxToolCalls > 0 &&
      this.toolCalls >= this.config.maxToolCalls
    ) {
      return this.finish('hard', 'tool_calls', 'tool_call_limit');
    }

    // soft
    if (this.totalTokens >= this.softTokens || elapsedMs >= this.softWallClockMs) {
      if (this.config.autoRenewOnProgress && hasProgress && this.renews < this.config.maxRenews) {
        this.renew(elapsedMs);
        return this.finish('ok', undefined, 'ok');
      }
      const reason: 'tokens' | 'wall_clock' =
        this.totalTokens >= this.softTokens ? 'tokens' : 'wall_clock';
      return this.finish('soft', reason, 'soft');
    }

    return this.finish('ok', undefined, 'ok');
  }

  /**
   * 兼容旧 API：返回字符串状态。
   * soft 未续租时返回 'soft'；硬限返回旧 reason 字符串。
   */
  check(hasProgress = true): BudgetStatus {
    return this.evaluate(hasProgress).legacyStatus;
  }

  /**
   * 检查并在 hard 时发射 EventBus 事件（内部订阅者）。
   * 用户可见停止必须由 reliability yield AgentLoopEvent。
   *
   * @returns true 表示可继续
   */
  checkAndEmit(hasProgress = true): boolean {
    const result = this.evaluate(hasProgress);
    if (result.status === 'hard') {
      this.eventBus.emit({
        type: AgentEvents.BUDGET_EXCEEDED,
        timestamp: Date.now(),
        data: { status: result.legacyStatus, report: result.report },
      });
      return false;
    }
    return true;
  }

  recordIteration(): void {
    this.iterations++;
  }

  recordToolCall(n = 1): void {
    this.toolCalls += n;
  }

  consumeTokens(tokens: number): void {
    if (tokens > 0) this.totalTokens += tokens;
  }

  report(): BudgetReport {
    return this.evaluate(true).report;
  }

  getConfig(): IterationBudgetConfig {
    return { ...this.config };
  }

  // ── 内部 ──

  private renew(elapsedMs: number): void {
    const grantTokens = this.config.renewGrantTokens ?? Math.floor(this.softTokens * 0.5);
    const grantMs = this.config.renewGrantMs ?? Math.floor(this.softWallClockMs * 0.5);
    this.softTokens = this.totalTokens + grantTokens;
    this.softWallClockMs = elapsedMs + grantMs;
    this.renews++;
    this.eventBus.emit({
      type: 'budget.renewed',
      timestamp: Date.now(),
      data: {
        renews: this.renews,
        softTokens: this.softTokens,
        softWallClockMs: this.softWallClockMs,
      },
    });
  }

  private finish(
    status: 'ok' | 'soft' | 'hard',
    reason: BudgetEvaluation['reason'],
    legacyStatus: BudgetStatus,
  ): BudgetEvaluation {
    return {
      status,
      reason,
      legacyStatus,
      report: this.buildReport(legacyStatus),
    };
  }

  private buildReport(status: BudgetStatus): BudgetReport {
    const elapsedMs = Date.now() - this.startTime;
    return {
      status,
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      totalTokens: this.totalTokens,
      elapsedMs,
      renews: this.renews,
      remaining: {
        iterations:
          this.config.maxIterations !== undefined
            ? Math.max(0, this.config.maxIterations - this.iterations)
            : null,
        toolCalls:
          this.config.maxToolCalls !== undefined
            ? Math.max(0, this.config.maxToolCalls - this.toolCalls)
            : null,
        tokens: Math.max(0, this.config.maxTokens - this.totalTokens),
        wallClockMs: Math.max(0, this.config.maxWallClockMs - elapsedMs),
      },
      soft: {
        tokens: this.softTokens,
        wallClockMs: this.softWallClockMs,
      },
      hard: {
        tokens: this.config.maxTokens,
        wallClockMs: this.config.maxWallClockMs,
      },
    };
  }
}
