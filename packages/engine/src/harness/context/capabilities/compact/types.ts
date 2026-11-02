/**
 * Compact 公用能力 — 类型
 *
 * @module harness/context/capabilities/compact/types
 */

import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import type { SummaryCoverage, SummaryPolicy } from '../summary/types.js';

export type CompactMode =
  | 'structure_only'
  | 'summary_only'
  | 'head_tail_only'
  | 'auto';

/**
 * 摘要执行函数（族 A 交接式摘要的唯一执行契约，manual / proactive / overflow 共用）。
 *
 * 契约（迭代式更新）：`options.previousSummary` 已按约定嵌入 `messages` 正文
 * （"Previous summary: …" 段），实现方无需再读 opts 拼 prompt；**返回值即完整
 * 更新后的摘要**，调用方不得再与旧摘要拼接。
 *
 * @param messages - 摘要请求消息（system 指令 + 用户正文；非原始对话序列）
 * @param options - 摘要选项
 * @returns 完整更新后的摘要文本
 */
export type SummarizeFunction = (
  messages: LLMMessage[],
  options?: {
    /** 上次摘要（已嵌入 messages 正文；仅作元信息回传） */
    previousSummary?: string;
    /** 摘要 token 预算 */
    maxTokens?: number;
    /** 自定义指令 */
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
  /** conversation 策略或显式 policy / id；经 buildSystemPrompt 产指令，要求 output:'text' 策略 */
  summarizePolicy?: SummaryPolicy | string;
  /** 注入的摘要执行函数（族 A；契约见 SummarizeFunction） */
  summarizeFn?: SummarizeFunction;
  onSummarizeFail?: 'truncate' | 'keep_partial';
  estimator?: CompactTokenEstimator;
  previousSummary?: string;
  maxSummaryTokens?: number;
  /**
   * 摘要软目标预算（P1c 拍板缺省 clamp(2%, 2k, 8k)）：写进指令的「尽量控制在 N tokens」，
   * 只作软目标——禁止把 provider max_tokens 设成 N（硬截断会产生静默半截摘要）。
   */
  summaryBudget?: { ratioPct?: number; minTokens?: number; maxTokens?: number };
  /**
   * 交接式摘要的注入素材：当前会话 task 快照（B0：易变块走 content 尾部指令，不进 system）。
   */
  taskSnapshot?: string;
  /**
   * 折叠区间（评审 F7）：告知摘要器「本次交接书将替换到第几条、尾部多少条原样保留」，
   * 防止模型只总结眼前最近的尾部、漏掉真正要被折叠的旧中段。
   */
  foldRange?: { replacedCount: number; total: number; preservedTail: number };
  /** 会话模型窗口（评审 F5）：provider 多按 input+max_tokens ≤ window 校验，压缩恰在最满时触发 */
  contextWindow?: number;
  /** 会话模型输出上限（评审 F5）：保险丝不得越过模型自身的 max output */
  maxOutputTokens?: number;
  /**
   * 缓存前缀：会话 LLM 请求同形 system+history。
   * summarizeFn 路径只许尾部追加指令；禁止改写前缀字节。
   */
  llmPrefix?: import('@octopi-agent/core/interfaces/model-provider.js').LLMMessage[];
  signal?: AbortSignal;
  emit?: (e: {
    type: 'compact.start' | 'compact.end' | 'compact.error' | 'compact.summarize_fallback';
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
  /** 本次是否产出了**新的**语义摘要（评审 F1）：false 时 summary 只是旧摘要兜底，
   *  调用方不得据此推进覆盖计数/覆盖点（否则未摘要的中段会被记成「已覆盖」）。 */
  fresh?: boolean;
  /** 本次是否真正发起过摘要 LLM 调用（成功/失败均算）：冷却时间戳只随 true 推进（F8R-01）。
   *  必填（显式标注，杜绝空值歧义）：机械/早退路径
   *  （empty、within_target、too_short、head_tail_only）显式 false，不许留空。 */
  summarizeAttempted: boolean;
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
  estimator?: CompactTokenEstimator;
}
