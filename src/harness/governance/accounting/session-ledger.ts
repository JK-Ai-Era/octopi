/**
 * SessionLedger — Session 级用量账本（P4）
 *
 * 累计同一 session 下多个 run 的用量。
 * 见 arch/budget-redesign.md：Session 级为后续 Quota 挂载。
 */

import type { UsageLedgerSnapshot } from './usage-ledger.js';

/** Session 账本快照 */
export interface SessionLedgerSnapshot {
  sessionId: string;
  agentId?: string;
  /** 累计的 run 数量 */
  runCount: number;
  cacheAware: boolean;
  llmCalls: number;
  inputUncachedTokens: number;
  inputCachedTokens: number;
  inputCacheWriteTokens: number;
  outputTokens: number;
  nominalTotalTokens: number;
  summaryLlmCalls: number;
  summaryOutputTokens: number;
  toolCalls: number;
  /** 首次 run 开始时间 */
  firstRunAt: number;
  /** 最近一次 run 结束时间 */
  lastRunAt: number;
  /** 累计运行时间（各 run elapsedMs 之和） */
  totalElapsedMs: number;
}

/**
 * SessionLedger
 *
 * 用于累计同一 session 下多个 run 的用量。
 * 每次 run 结束时，调用 `mergeRunSnapshot` 合并 run 级快照。
 */
export class SessionLedger {
  private readonly sessionId: string;
  private readonly agentId?: string;
  private runCount = 0;
  private cacheAware = false;
  private llmCalls = 0;
  private inputUncachedTokens = 0;
  private inputCachedTokens = 0;
  private inputCacheWriteTokens = 0;
  private outputTokens = 0;
  private nominal = 0;
  private summaryLlmCalls = 0;
  private summaryOutputTokens = 0;
  private toolCalls = 0;
  private firstRunAt = 0;
  private lastRunAt = 0;
  private totalElapsedMs = 0;

  constructor(sessionId: string, agentId?: string) {
    this.sessionId = sessionId;
    this.agentId = agentId;
  }

  /**
   * 合并一个 run 级快照到 session 账本
   *
   * @param snapshot - run 级 UsageLedgerSnapshot
   */
  mergeRunSnapshot(snapshot: UsageLedgerSnapshot): void {
    this.runCount++;
    if (snapshot.cacheAware) this.cacheAware = true;
    this.llmCalls += snapshot.llmCalls;
    this.inputUncachedTokens += snapshot.inputUncachedTokens;
    this.inputCachedTokens += snapshot.inputCachedTokens;
    this.inputCacheWriteTokens += snapshot.inputCacheWriteTokens;
    this.outputTokens += snapshot.outputTokens;
    this.nominal += snapshot.nominalTotalTokens;
    this.summaryLlmCalls += snapshot.summaryLlmCalls ?? 0;
    this.summaryOutputTokens += snapshot.summaryOutputTokens ?? 0;
    this.toolCalls += snapshot.toolCalls;
    this.totalElapsedMs += snapshot.elapsedMs;

    const now = Date.now();
    if (this.firstRunAt === 0) {
      this.firstRunAt = now - snapshot.elapsedMs;
    }
    this.lastRunAt = now;
  }

  /**
   * 快照
   *
   * @returns SessionLedgerSnapshot
   */
  snapshot(): SessionLedgerSnapshot {
    return {
      sessionId: this.sessionId,
      agentId: this.agentId,
      runCount: this.runCount,
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
      firstRunAt: this.firstRunAt,
      lastRunAt: this.lastRunAt,
      totalElapsedMs: this.totalElapsedMs,
    };
  }
}