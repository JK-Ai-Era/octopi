/**
 * Turn（轮次）类型 + TokenUsage（cache-aware）
 *
 * 见 arch/budget-redesign.md P1：账本吃 provider 分项，禁止用 nominal Σ 做默认 hard。
 */

import type { Message } from './messages.js';

/**
 * Token 使用量 — provider 忠实分项
 *
 * - `cacheAware=true`：已解析 cache 字段
 * - `cacheAware=false`：无 cache 信息时，`inputUncachedTokens` ≈ provider 报告的 prompt
 */
export interface TokenUsage {
  /** output / completion */
  outputTokens: number;
  /** 标准价 input（不含 cache hit/write） */
  inputUncachedTokens: number;
  /** cache read */
  inputCachedTokens: number;
  /** cache write / creation */
  inputCacheWriteTokens: number;
  /** provider 报告的 prompt 总量（若有）；诊断/上下文估算用，禁止 policy hard */
  inputReportedTokens?: number;
  /** 是否具备 cache 分项 */
  cacheAware: boolean;
  /** provider 原样透传 */
  raw?: Record<string, unknown>;
}

/** 空 usage */
export function emptyTokenUsage(): TokenUsage {
  return {
    outputTokens: 0,
    inputUncachedTokens: 0,
    inputCachedTokens: 0,
    inputCacheWriteTokens: 0,
    cacheAware: false,
  };
}

/**
 * 从 provider/测试的旧口语义构造 TokenUsage
 *
 * @param input - prompt/completion 可选 cache 分项
 * @returns TokenUsage
 */
export function makeTokenUsage(input: {
  promptTokens?: number;
  completionTokens?: number;
  promptCachedTokens?: number;
  promptCacheWriteTokens?: number;
  cacheAware?: boolean;
  raw?: Record<string, unknown>;
}): TokenUsage {
  const reported = input.promptTokens ?? 0;
  const cached = input.promptCachedTokens ?? 0;
  const cacheWrite = input.promptCacheWriteTokens ?? 0;
  const cacheAware = input.cacheAware ?? (cached > 0 || cacheWrite > 0);
  const uncached = cacheAware ? Math.max(0, reported - cached - cacheWrite) : reported;
  return {
    outputTokens: input.completionTokens ?? 0,
    inputUncachedTokens: uncached,
    inputCachedTokens: cached,
    inputCacheWriteTokens: cacheWrite,
    inputReportedTokens: reported,
    cacheAware,
    raw: input.raw,
  };
}

/**
 * 名义总 tokens（诊断/账本累计）：reported input（或分项之和）+ output
 *
 * @param usage - TokenUsage
 * @returns number
 */
export function nominalTotalTokens(usage: TokenUsage): number {
  const input =
    usage.inputReportedTokens ??
    usage.inputUncachedTokens + usage.inputCachedTokens + usage.inputCacheWriteTokens;
  return input + usage.outputTokens;
}

/**
 * provider 报告的 prompt（上下文估算优先）
 *
 * @param usage - TokenUsage
 * @returns number
 */
export function reportedPromptTokens(usage: TokenUsage): number {
  return (
    usage.inputReportedTokens ??
    usage.inputUncachedTokens + usage.inputCachedTokens + usage.inputCacheWriteTokens
  );
}

/** Turn — 一次完整的 Agent 调用 */
export interface Turn {
  id: string;
  input: Message[];
  output: Message;
  usage?: TokenUsage;
  durationMs: number;
  model: string;
  timestamp: number;
}
