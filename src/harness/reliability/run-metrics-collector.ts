/**
 * RunMetricsCollector — 单次 run 的观察层
 *
 * 归属 reliability（实现）；Guard 只依赖 Core 的 CheckpointContext 类型。
 * 禁止：reliability → run-guard 实现包。
 */

import type {
  CheckpointContext,
  CheckpointMetrics,
  TurnSummary,
  RecoveryAttemptRecord,
} from '../../core/interfaces/run-guard.js';

/** 恢复尝试记录 */
export type RecoveryAttempt = RecoveryAttemptRecord;

/** 外部高危信号 */
export interface ExternalRunSignal {
  source: string;
  level: 'warning' | 'critical';
  detail: string;
  timestamp: number;
}

const SUMMARIES_MAX = 8;
const RECENT_TOOLS_MAX = 10;
const TOKEN_WINDOW = 10;

export class RunMetricsCollector {
  private readonly startTime = Date.now();
  private globalIteration = 0;
  private totalToolCalls = 0;
  private nominalTotalTokens = 0;
  private lastToolName = '';
  private consecutiveSameTool = 0;
  private consecutiveErrors = 0;
  private uniqueTools = new Set<string>();
  private recentToolCalls: Array<{ name: string; success: boolean }> = [];
  private turnSummaries: TurnSummary[] = [];
  private tokenDeltas: number[] = [];
  private recoveryHistory: RecoveryAttempt[] = [];
  private externalSignals: ExternalRunSignal[] = [];
  private noopStreak = 0;
  private lastSuccessAt = 0;
  private lastSubstantialTextAt = 0;

  /** 记录一轮结束（token 另经 recordTokens 从 turn_end.usage 累加） */
  recordTurn(summary: TurnSummary): void {
    this.globalIteration++;
    this.turnSummaries.push(summary);
    if (this.turnSummaries.length > SUMMARIES_MAX) {
      this.turnSummaries = this.turnSummaries.slice(-SUMMARIES_MAX);
    }
    if (summary.contentPreview && summary.contentPreview.length >= 80) {
      this.lastSubstantialTextAt = this.globalIteration;
    }
  }

  /** 记录本轮 token 消耗（与 Budget 共用 turn_end.usage） */
  recordTokens(delta: number): void {
    if (delta <= 0) return;
    this.nominalTotalTokens += delta;
    this.tokenDeltas.push(delta);
    if (this.tokenDeltas.length > TOKEN_WINDOW) this.tokenDeltas.shift();
    const last = this.turnSummaries[this.turnSummaries.length - 1];
    if (last) last.tokenDelta += delta;
  }

  /** 记录工具结果 */
  recordToolResult(name: string, success: boolean, isNoop = false): void {
    this.totalToolCalls++;
    if (name === this.lastToolName) {
      this.consecutiveSameTool++;
    } else {
      this.consecutiveSameTool = 1;
      this.lastToolName = name;
    }
    this.uniqueTools.add(name);
    this.recentToolCalls.push({ name, success });
    if (this.recentToolCalls.length > RECENT_TOOLS_MAX) this.recentToolCalls.shift();
    if (success) {
      this.consecutiveErrors = 0;
      if (!isNoop) {
        this.lastSuccessAt = this.globalIteration;
        this.noopStreak = 0;
      }
    } else {
      this.consecutiveErrors++;
    }
    if (isNoop) this.noopStreak++;
  }

  /** 本轮是否实质进展（Budget 续租 + Guard 规则共用） */
  hasProgress(): boolean {
    if (this.noopStreak >= 3) return false;
    // 成功工具或实质文本出现在最近 3 轮内
    if (this.globalIteration - this.lastSuccessAt <= 3 && this.lastSuccessAt > 0) return true;
    if (
      this.globalIteration - this.lastSubstantialTextAt <= 3 &&
      this.lastSubstantialTextAt > 0
    ) {
      return true;
    }
    // 刚开始的 run：尚无失败堆积时视为有进展
    if (this.globalIteration <= 2 && this.consecutiveErrors === 0) return true;
    // 连续无成功且无实质文本
    if (
      this.globalIteration - Math.max(this.lastSuccessAt, this.lastSubstantialTextAt) >= 3 &&
      this.globalIteration >= 3
    ) {
      return false;
    }
    return this.consecutiveErrors === 0;
  }

  recordRecovery(attempt: RecoveryAttempt): void {
    this.recoveryHistory.push(attempt);
    if (this.recoveryHistory.length > 20) {
      this.recoveryHistory = this.recoveryHistory.slice(-20);
    }
  }

  noteExternalSignal(sig: ExternalRunSignal): void {
    this.externalSignals.push(sig);
    if (this.externalSignals.length > 10) {
      this.externalSignals = this.externalSignals.slice(-10);
    }
  }

  /** 清空已消费的 external signals（检查点后） */
  drainExternalSignals(): ExternalRunSignal[] {
    const s = this.externalSignals;
    this.externalSignals = [];
    return s;
  }

  get iteration(): number {
    return this.globalIteration;
  }

  get tokens(): number {
    return this.nominalTotalTokens;
  }

  get elapsedMs(): number {
    return Date.now() - this.startTime;
  }

  buildContext(ids: { sessionId?: string; agentId?: string }): CheckpointContext {
    const recentFailures = this.recentToolCalls.filter(t => !t.success).length;
    const toolFailureRate =
      this.recentToolCalls.length > 0 ? recentFailures / this.recentToolCalls.length : 0;

    // tokenGrowthRate：近半窗 / 前半窗
    let tokenGrowthRate = 0;
    const n = this.tokenDeltas.length;
    if (n >= 4) {
      const half = Math.floor(n / 2);
      const recent = this.tokenDeltas.slice(-half).reduce((a, b) => a + b, 0);
      const prior = this.tokenDeltas.slice(-half * 2, -half).reduce((a, b) => a + b, 0);
      if (prior > 0) tokenGrowthRate = recent / prior - 1;
      else if (recent > 0) tokenGrowthRate = 1;
      // 夹到 [0, 1] 供规则阈值使用（负增长视为 0）
      if (tokenGrowthRate < 0) tokenGrowthRate = 0;
      if (tokenGrowthRate > 1) tokenGrowthRate = 1;
    }

    const metrics: CheckpointMetrics = {
      consecutiveErrors: this.consecutiveErrors,
      consecutiveSameTool: this.consecutiveSameTool,
      tokenGrowthRate,
      toolFailureRate,
      uniqueToolsUsed: this.uniqueTools.size,
      hasProgress: this.hasProgress(),
      noopStreak: this.noopStreak,
    };

    return {
      sessionId: ids.sessionId ?? 'inline',
      agentId: ids.agentId ?? 'default',
      iteration: this.globalIteration,
      totalToolCalls: this.totalToolCalls,
      nominalTotalTokens: this.nominalTotalTokens,
      elapsedMs: Date.now() - this.startTime,
      recentSummaries: this.turnSummaries.slice(-8),
      metrics,
      recoveryHistory: [...this.recoveryHistory],
      externalSignals: this.externalSignals.map(s => ({
        source: s.source,
        level: s.level,
        detail: s.detail,
      })),
    };
  }

  /**
   * Observer 通道用的可序列化快照
   *
   * @param ids - session/agent
   * @returns RunGuardMetrics 投影
   */
  toObserverSnapshot(ids: { sessionId?: string; agentId?: string } = {}): {
    sessionId?: string;
    agentId?: string;
    iteration: number;
    totalToolCalls: number;
    nominalTotalTokens: number;
    elapsedMs: number;
    consecutiveErrors: number;
    consecutiveSameTool: number;
    noopStreak: number;
    hasProgress: boolean;
    uniqueTools: string[];
    recentTools: Array<{ name: string; success: boolean }>;
    recoveryCount: number;
  } {
    return {
      sessionId: ids.sessionId,
      agentId: ids.agentId,
      iteration: this.globalIteration,
      totalToolCalls: this.totalToolCalls,
      nominalTotalTokens: this.nominalTotalTokens,
      elapsedMs: Date.now() - this.startTime,
      consecutiveErrors: this.consecutiveErrors,
      consecutiveSameTool: this.consecutiveSameTool,
      noopStreak: this.noopStreak,
      hasProgress: this.hasProgress(),
      uniqueTools: [...this.uniqueTools],
      recentTools: this.recentToolCalls.slice(-10),
      recoveryCount: this.recoveryHistory.length,
    };
  }
}
