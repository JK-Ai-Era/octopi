/**
 * BudgetPolicyEngine — Run 级资源安全阀（P5 正式定名）
 *
 * 地位：harness 非领域模块。见 arch/budget-redesign.md。
 *
 * P0 语义（已评审）：
 * - 出厂 **不** 因 Σ nominalTotalTokens（nominal spend）停止 Run
 * - soft / 续租 / maxTokens 硬顶已删除
 * - 默认仅 wall-clock 安全阀（6h，可配）
 * - maxIterations / maxToolCalls 仅显式配置时硬停
 * - 成本/配额策略见后续 budgetPolicy（P3）；账本见 UsageLedger（P1）
 */

// ── 配置 ──

/** Run 安全阀配置（实现侧；JSON 见 config.BudgetPolicyJsonConfig） */
export interface BudgetPolicyConfig {
  /**
   * 最大迭代次数。仅当显式设置时作为硬停。
   * 默认省略：长任务不靠 iteration 卡死；行为跑飞由 RunGuard 负责。
   */
  maxIterations?: number;
  /** 最大工具调用次数。仅当显式设置时作为硬停。 */
  maxToolCalls?: number;
  /** 硬顶：最大 wall-clock（毫秒）。出厂默认见 DEFAULT_BUDGET。 */
  maxWallClockMs: number;
}



/** 预算状态（无 soft；tokens 轴已移除） */
export type BudgetStatus = 'ok' | 'iteration_limit' | 'tool_call_limit' | 'timeout';

/** 评估结果 */
export interface BudgetEvaluation {
  status: 'ok' | 'hard';
  reason?: 'wall_clock' | 'iteration' | 'tool_calls';
  legacyStatus: BudgetStatus;
  report: BudgetReport;
}

/** 预算消耗报告（观测用；nominal tokens 不参与 hard） */
export interface BudgetReport {
  status: BudgetStatus;
  iterations: number;
  toolCalls: number;
  /** 诊断累计（Σ nominalTotalTokens）；**禁止**作为默认 hard 单位 */
  nominalTokens: number;
  elapsedMs: number;
  remaining: {
    iterations: number | null;
    toolCalls: number | null;
    wallClockMs: number;
  };
  hard: {
    wallClockMs: number;
    iterations: number | null;
    toolCalls: number | null;
  };
}

// ── 默认配置 ──

export const DEFAULT_BUDGET: BudgetPolicyConfig = {
  // 安全阀：防挂死；非成本模型
  maxWallClockMs: 6 * 3_600_000, // 6h
};

// ── 实现 ──

/**
 * BudgetPolicyEngine — Run 级资源安全阀
 *
 * 每轮由 runAgentWithReliability 检查。
 * P5 正式定名；旧 IterationBudget / RunBudget 已删除，无别名。
 */
export class BudgetPolicyEngine {
  private config: BudgetPolicyConfig;
  private iterations = 0;
  private toolCalls = 0;
  private nominalTokens = 0;
  private startTime: number;

  constructor(config?: Partial<BudgetPolicyConfig>) {
    this.config = { ...DEFAULT_BUDGET, ...config };
    this.startTime = Date.now();
  }

  /** 重置计数（Gateway 长驻每请求调用）；保留配置 */
  reset(): void {
    this.iterations = 0;
    this.toolCalls = 0;
    this.nominalTokens = 0;
    this.startTime = Date.now();
  }

  /**
   * 仅检查 hard（无 soft 路径）。
   */
  checkHardOnly(): {
    status: 'ok' | 'hard';
    reason?: BudgetEvaluation['reason'];
    report: BudgetReport;
  } {
    const elapsedMs = Date.now() - this.startTime;
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
   * 评估预算（与 checkHardOnly 同 hard 语义；hasProgress 不再触发续租）
   *
   * @param _hasProgress - 保留参数位；P0 起不参与裁决
   */
  evaluate(_hasProgress = true): BudgetEvaluation {
    const hard = this.checkHardOnly();
    return {
      status: hard.status,
      reason: hard.reason,
      legacyStatus: hard.report.status,
      report: hard.report,
    };
  }

  /**
   * 兼容 API：返回字符串状态。
   */
  check(_hasProgress = true): BudgetStatus {
    return this.checkHardOnly().report.status;
  }

  // 注：用户可见停止走 reliability yield `budget_exceeded` → Runner 桥接。

  recordIteration(): void {
    this.iterations++;
  }

  recordToolCall(n = 1): void {
    this.toolCalls += n;
  }

  /** 仅记账/诊断；**不**触发 hard */
  consumeTokens(tokens: number): void {
    if (tokens > 0) this.nominalTokens += tokens;
  }

  report(): BudgetReport {
    return this.checkHardOnly().report;
  }

  getConfig(): BudgetPolicyConfig {
    return { ...this.config };
  }

  private buildReport(status: BudgetStatus): BudgetReport {
    const elapsedMs = Date.now() - this.startTime;
    return {
      status,
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      nominalTokens: this.nominalTokens,
      elapsedMs,
      remaining: {
        iterations:
          this.config.maxIterations !== undefined
            ? Math.max(0, this.config.maxIterations - this.iterations)
            : null,
        toolCalls:
          this.config.maxToolCalls !== undefined
            ? Math.max(0, this.config.maxToolCalls - this.toolCalls)
            : null,
        wallClockMs: Math.max(0, this.config.maxWallClockMs - elapsedMs),
      },
      hard: {
        wallClockMs: this.config.maxWallClockMs,
        iterations: this.config.maxIterations ?? null,
        toolCalls: this.config.maxToolCalls ?? null,
      },
    };
  }
}

