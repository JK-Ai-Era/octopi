/**
 * UsageLedger — Run/Session 级用量账本（Accounting）
 *
 * 见 arch/budget-redesign.md：只记录，不 kill。Policy 另层（P3+）。
 */

import type { TokenUsage } from '../../core/types/turn.js';
import { nominalTotalTokens } from '../../core/types/turn.js';

/** 账本快照（Observer + Policy 只读输入） */
export interface UsageLedgerSnapshot {
  scope: 'run' | 'session';
  sessionId?: string;
  agentId?: string;
  cacheAware: boolean;
  llmCalls: number;
  inputUncachedTokens: number;
  inputCachedTokens: number;
  inputCacheWriteTokens: number;
  outputTokens: number;
  /** 诊断：Σ nominal；禁止默认 policy 单位（设计字段名 nominalTotalTokens） */
  nominalTotalTokens: number;
  /** capabilities/summary 专用调用（若有） */
  summaryLlmCalls?: number;
  summaryOutputTokens?: number;
  toolCalls: number;
  elapsedMs: number;
  /** P5: context 估算 tokens（最新值） */
  contextEstTokens?: number;
  /** P5: context 窗口大小（模型能力） */
  contextWindowTokens?: number;
  /** P5: 估算花费（币种由 pricing 决定） */
  estimatedCost?: number;
  /** P5: 工具出口净化效果（capabilities L1/L2 应用次数） */
  toolSummaryApplied?: number;
  /** P5: 工具输出原始字符数（净化前） */
  toolOutputRawChars?: number;
  /** P5: 工具输出返回字符数（净化后） */
  toolOutputReturnedChars?: number;
  /** P5: 工具副作用计数（I5，按类型分组） */
  toolEffects?: Record<string, number>;
}

/**
 * UsageLedger
 */
export class UsageLedger {
  private readonly startTime = Date.now();
  private llmCalls = 0;
  private cacheAware = false;
  private inputUncachedTokens = 0;
  private inputCachedTokens = 0;
  private inputCacheWriteTokens = 0;
  private outputTokens = 0;
  private nominal = 0;
  private summaryLlmCalls = 0;
  private summaryOutputTokens = 0;
  private toolCalls = 0;
  private contextEstTokens?: number;
  private contextWindowTokens?: number;
  private toolSummaryApplied = 0;
  private toolOutputRawChars = 0;
  private toolOutputReturnedChars = 0;
  private toolEffects: Record<string, number> = {};

  /**
   * 记录一次 LLM usage
   *
   * @param usage - provider 分项 usage
   * @param opts - 可选 summary 归因
   */
  recordUsage(usage: TokenUsage | undefined, opts?: { summary?: boolean }): void {
    if (!usage) return;
    this.llmCalls++;
    if (usage.cacheAware) this.cacheAware = true;
    this.inputUncachedTokens += usage.inputUncachedTokens;
    this.inputCachedTokens += usage.inputCachedTokens;
    this.inputCacheWriteTokens += usage.inputCacheWriteTokens;
    this.outputTokens += usage.outputTokens;
    this.nominal += nominalTotalTokens(usage);
    if (opts?.summary) {
      this.summaryLlmCalls++;
      this.summaryOutputTokens += usage.outputTokens;
    }
  }

  /** @param n - 工具调用次数 */
  recordToolCall(n = 1): void {
    this.toolCalls += n;
  }

  /**
   * 更新 context 压力信息
   *
   * @param estimatedTokens - 当前 context 估算 tokens
   * @param contextWindow - 模型 context 窗口大小（可选）
   */
  updateContextPressure(estimatedTokens: number, contextWindow?: number): void {
    this.contextEstTokens = estimatedTokens;
    if (contextWindow !== undefined) {
      this.contextWindowTokens = contextWindow;
    }
  }

  /**
   * 记录工具出口净化效果（capabilities L1/L2）
   *
   * @param applied - 是否应用了 summary
   * @param rawChars - 原始输出字符数
   * @param returnedChars - 返回输出字符数
   */
  recordToolSummary(applied: boolean, rawChars: number, returnedChars: number): void {
    if (applied) this.toolSummaryApplied++;
    this.toolOutputRawChars += rawChars;
    this.toolOutputReturnedChars += returnedChars;
  }

  /**
   * 记录工具副作用（I5）
   *
   * @param effectType - 副作用类型（如 'write', 'delete', 'execute'）
   * @param count - 次数
   */
  recordToolEffect(effectType: string, count = 1): void {
    this.toolEffects[effectType] = (this.toolEffects[effectType] ?? 0) + count;
  }

  /** 重置（per-run 克隆时用新实例即可） */
  reset(): void {
    this.llmCalls = 0;
    this.cacheAware = false;
    this.inputUncachedTokens = 0;
    this.inputCachedTokens = 0;
    this.inputCacheWriteTokens = 0;
    this.outputTokens = 0;
    this.nominal = 0;
    this.summaryLlmCalls = 0;
    this.summaryOutputTokens = 0;
    this.toolCalls = 0;
    this.contextEstTokens = undefined;
    this.contextWindowTokens = undefined;
    this.toolSummaryApplied = 0;
    this.toolOutputRawChars = 0;
    this.toolOutputReturnedChars = 0;
    this.toolEffects = {};
  }

  /**
   * 快照
   *
   * @param meta - scope 元数据
   * @returns UsageLedgerSnapshot
   */
  snapshot(
    meta: {
      scope?: 'run' | 'session';
      sessionId?: string;
      agentId?: string;
    } = {},
  ): UsageLedgerSnapshot {
    return {
      scope: meta.scope ?? 'run',
      sessionId: meta.sessionId,
      agentId: meta.agentId,
      cacheAware: this.cacheAware,
      llmCalls: this.llmCalls,
      inputUncachedTokens: this.inputUncachedTokens,
      inputCachedTokens: this.inputCachedTokens,
      inputCacheWriteTokens: this.inputCacheWriteTokens,
      outputTokens: this.outputTokens,
      nominalTotalTokens: this.nominal,
      summaryLlmCalls: this.summaryLlmCalls,
      summaryOutputTokens: this.summaryOutputTokens,
      toolCalls: this.toolCalls,
      elapsedMs: Date.now() - this.startTime,
      contextEstTokens: this.contextEstTokens,
      contextWindowTokens: this.contextWindowTokens,
      toolSummaryApplied: this.toolSummaryApplied,
      toolOutputRawChars: this.toolOutputRawChars,
      toolOutputReturnedChars: this.toolOutputReturnedChars,
      toolEffects: Object.keys(this.toolEffects).length > 0 ? this.toolEffects : undefined,
    };
  }
}
