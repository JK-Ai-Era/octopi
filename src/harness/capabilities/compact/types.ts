/**
 * Compact 公用能力 — 类型
 *
 * @module harness/capabilities/compact/types
 */

import type { Message } from '../../../core/types.js';
import type { LLMMessage } from '../../../core/interfaces/model-provider.js';
import type { SummaryCoverage, SummaryPolicy, SummaryPort } from '../summary/types.js';

export type CompactMode =
  | 'structure_only'
  | 'summary_only'
  | 'head_tail_only'
  | 'auto';

export type CompactSummarizeFn = (
  messages: LLMMessage[],
  options?: {
    previousSummary?: string;
    maxTokens?: number;
    instructions?: string;
  },
) => Promise<string>;

export interface CompactTokenEstimator {
  estimateMessages(messages: Message[]): number;
  estimateText(text: string): number;
}

export interface CompactOptions {
  protectHead?: number;
  protectTail?: number;
  targetTokens?: number;
  mode?: CompactMode;
  /** conversation 策略或显式 policy / id；经 SummaryPort 时生效 */
  summarizePolicy?: SummaryPolicy | string;
  /** 兼容 ContextEngine 注入的 SummarizeFunction */
  summarizeFn?: CompactSummarizeFn;
  /** 优先走 SummaryPort（conversation policy）；缺省时用 summarizeFn */
  summaryPort?: SummaryPort;
  onSummarizeFail?: 'truncate' | 'keep_partial';
  estimator?: CompactTokenEstimator;
  previousSummary?: string;
  maxSummaryTokens?: number;
  signal?: AbortSignal;
  emit?: (e: {
    type: 'compact.start' | 'compact.end' | 'compact.error';
    reason?: string;
    cached?: boolean;
  }) => void;
}

export interface CompactOutcome {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  tokensBefore: number;
  tokensAfter?: number;
  summary?: string;
  coverage?: SummaryCoverage;
  /** Message[] 或纯文本结果，由入口决定 */
  view: Message[] | string;
  droppedSummary?: string;
}

export interface CompactEngine {
  /**
   * 压缩消息序列（会话 / 旁路）
   *
   * @param messages - 全量消息
   * @param options - 调用方可指定的压缩规则
   * @returns 压缩结果（view 为 Message[]）
   */
  compactMessages(messages: Message[], options?: CompactOptions): Promise<CompactOutcome>;
  /**
   * 压缩纯文本
   *
   * @param text - 原文
   * @param options - 压缩规则
   * @returns 压缩结果（view 为 string）
   */
  compactText(text: string, options?: CompactOptions): Promise<CompactOutcome>;
}

export interface CreateCompactEngineOptions {
  defaultProtectHead?: number;
  defaultProtectTail?: number;
  defaultTargetTokens?: number;
  defaultMode?: CompactMode;
  summaryPort?: SummaryPort;
  estimator?: CompactTokenEstimator;
}
