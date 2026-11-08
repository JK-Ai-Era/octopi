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
    /**
     * usage 回传（2026-11-08 outputTokens 真值）：摘要请求的 provider 实测输出 tokens。
     * 摘要产物的体量以此为准（真值），估算只作无回传时的兜底——「放着真值用估算」
     * 是压缩计量的口径缺陷（tokensBefore/After 核对，2026-11-08）。
     */
    onUsage?: (usage: { outputTokens?: number }) => void;
    /**
     * 中止信号（P3）：run 中止或摘要预算超时都必须能取消在飞请求，
     * 否则 UI 只能干等到 provider 侧超时（2026-11-07 事故：2.13MB 非流式请求挂 20+ 分钟）。
     */
    signal?: AbortSignal;
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
  /** Hook 归因身份：手动压缩不在 RunScope 内，调用方显式身份优先于 RunScope 回落 */
  sessionId?: string;
  agentId?: string;
  /** conversation 策略或显式 policy / id；经 buildSystemPrompt 产指令，要求 output:'text' 策略 */
  summarizePolicy?: SummaryPolicy | string;
  /** 注入的摘要执行函数（族 A；契约见 SummarizeFunction） */
  summarizeFn?: SummarizeFunction;
  /** 摘要失败/取消时的降级策略：truncate=裁掉未覆盖中段（宁可瘦不丢坏），keep_partial=保留部分产物 */
  onSummarizeFail?: 'truncate' | 'keep_partial';
  estimator?: CompactTokenEstimator;
  previousSummary?: string;
  /**
   * 摘要增量素材（M-4）：上一份摘要覆盖终点之后、保护尾之前的新消息。与 previousSummary
   * 同时给出时，textify 旁路只文本化本段（合并契约：previousSummary + 新消息 = 完整
   * 更新），不再把已覆盖历史以全量 raw middle 复发（2.13MB 事故形状）。缺省 = 全量
   * middle（首次压缩/无摘要兜底）。
   */
  freshMessages?: Message[];
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
  foldRange?: {
    /** 本次需要并入摘要的消息条数（既有摘要之后、保护尾之前） */
    replacedCount: number;
    /** 会话消息总数 */
    total: number;
    /** 原样保留的尾部条数 */
    preservedTail: number;
    /** 前缀里上一份摘要已经代表的早期消息条数（0/缺省 = 无既有摘要） */
    coveredCount?: number;
  };
  /** 会话模型窗口（评审 F5）：provider 多按 input+max_tokens ≤ window 校验，压缩恰在最满时触发 */
  contextWindow?: number;
  /** 会话模型输出上限（评审 F5）：保险丝不得越过模型自身的 max output */
  maxOutputTokens?: number;
  /**
   * 缓存前缀：会话 LLM 请求同形 system+history。
   * summarizeFn 路径只许尾部追加指令；禁止改写前缀字节。
   */
  llmPrefix?: import('@octopi-agent/core/interfaces/model-provider.js').LLMMessage[];
  /**
   * 回声比对源覆盖（P2）：前缀含既有摘要占位时，占位正文不得参与回声判定——
   * 模型复用/续写上一份交接书不是「复读原文」。缺省回落到前缀文本投影。
   */
  echoSource?: string;
  /**
   * 中止信号（P3）：run 中止 / 摘要预算超时 → 取消在飞摘要请求。
   * 取消产生的错误按 onSummarizeFail 降级（调用方另按 signal.aborted 决定是否写记录）。
   */
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
  /** 摘要覆盖终点（下标，不含）= tailStart：E4 状态推进与重放共用锚点。
   *  手动路径（structuralCompact）产出；失败/未新鲜摘要时携带旧值或留空。 */
  coveredMessageCount?: number;
  /** 本次是否产出了**新的**语义摘要（评审 F1）：false 时 summary 只是旧摘要兜底，
   *  调用方不得据此推进覆盖计数/覆盖点（否则未摘要的中段会被记成「已覆盖」）。 */
  fresh?: boolean;
  /** 本次是否真正发起过摘要 LLM 调用（成功/失败均算）：冷却时间戳只随 true 推进（F8R-01）。
   *  必填（显式标注，杜绝空值歧义）：机械/早退路径
   *  （empty、within_target、too_short、head_tail_only）显式 false，不许留空。 */
  summarizeAttempted: boolean;
  /** fresh 摘要响应的 provider 实测输出 tokens（onUsage 回传，2026-11-08）：
   *  摘要产物体量的真值；无回传（自定义 summarizeFn/失败）时缺省，计量回落估算。 */
  summaryOutputTokens?: number;
  coverage?: SummaryCoverage;
  /** Message[] 或纯文本结果，由入口决定 */
  view: Message[] | string;
  droppedSummary?: string;
}

/**
 * 锁面/传输层结果投影：`CompactOutcome` 去 `view`（大对象，UI 无需，不过锁面）。
 * 新增可选字段自动随契约流动——**禁止**在 runner/gateway 手抄字段表（会静默丢新字段）。
 */
export type CompactTransportOutcome = Omit<CompactOutcome, 'view'>;

/**
 * 把能力结果投影为传输结果（唯一投影实现）。
 *
 * @param result - 能力层压缩结果
 * @returns 剥离 view 后的传输结果
 */
export function toCompactTransport(result: CompactOutcome): CompactTransportOutcome {
  const { view: _view, ...rest } = result;
  void _view; // 有意剥离：view 不过锁面
  return rest;
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
