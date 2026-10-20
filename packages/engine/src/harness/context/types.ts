/**
 * ContextEngine — 上下文装配契约
 *
 * @layer harness/context — 产品端口（非 Core Kernel）。
 * 在有限上下文窗口内为模型选择/压缩最有价值的信息。
 *
 * 接入：Builder 经 convertToLlm 调用 assemble；Loop 不依赖本类型。
 */

import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage, LLMToolDefinition } from '@octopi-agent/core/interfaces/model-provider.js';

export type { LLMMessage, LLMToolDefinition };

// ── 引擎信息 ──

export interface ContextEngineInfo {
  /** 引擎唯一标识 */
  id: string;
  /** 引擎名称 */
  name: string;
}

// ── Token 估算 ──

/**
 * Token 估算器
 *
 * 负责估算内容的 token 数。
 * 策略：
 * 1. 优先使用 LLM 返回的实际 token 数（usage reported prompt）
 * 2. 次选：专用 tokenizer（如 tiktoken）
 * 3. 兜底：启发式估算
 *    - 英文：字符数 / 4
 *    - 中文：1 汉字 ≈ 1 token
 *    - 多模态：图片按固定 token 计（参考 OpenAI vision 定价）
 *
 * 本域契约；Harness 实现启发式/tokenizer 策略。
 */
export interface TokenEstimator {
  /** 估算单条消息的 token 数 */
  estimateMessage(message: Message): number;
  /** 估算多条消息的总 token 数 */
  estimateMessages(messages: Message[]): number;
  /** 估算文本的 token 数 */
  estimateText(text: string): number;
  /** 估算工具定义的 token 数 */
  estimateTools(tools: LLMToolDefinition[]): number;
}

// ── 组装参数 ──

/** 压缩原因：主动摘要 vs 硬溢出 */
export type ContextCompactReason = 'proactive' | 'overflow';

/**
 * 上下文压缩可观测事件
 *
 * 由 ContextEngine 在同步压缩前后发出，供 UI 显示「正在压缩上下文…」，
 * 避免 LLM 摘要耗时被误判为会话卡死。失败不中断本轮（引擎回退截断）。
 */
export interface ContextCompactEvent {
  type: 'context.compact.start' | 'context.compact.end' | 'context.compact.error';
  sessionId: string;
  reason?: ContextCompactReason;
  /** 压缩前估算 token */
  tokensBefore?: number;
  /** 压缩后估算 token（end） */
  tokensAfter?: number;
  /** 触发阈值（proactive） */
  threshold?: number;
  /** 耗时 ms（end/error） */
  durationMs?: number;
  /** 走缓存摘要重建，未调 LLM */
  cached?: boolean;
  error?: string;
}

/** 事件回调（Builder 注入 → EventBus） */
export type ContextEmitFn = (event: ContextCompactEvent) => void;

export interface AssembleParams {
  /** Session ID */
  sessionId: string;
  /** Agent ID（E4 compact 键分量；缺省时引擎状态退化为纯 sessionId） */
  agentId?: string;
  /** 当前消息历史 */
  messages: Message[];
  /** 系统提示词 */
  systemPrompt: string;
  /** 可用工具定义 */
  tools: LLMToolDefinition[];
  /**
   * Token 预算（可用空间）。
   * 未配置 contextWindow 时应省略：跳过基于窗口的自动压缩与预算截断。
   */
  tokenBudget?: number;
  /** 模型上下文窗口（仅显式配置时传入） */
  contextWindow?: number;
  /**
   * 显式压缩目标 token（context.compactTargetTokens）。
   * 与 contextWindow 无关；未知窗口时仍可作手动/结构压缩的目标。
   */
  compactTargetTokens?: number;
  /** 中止信号 */
  signal?: AbortSignal;
  /** Token 估算器（可选，未提供时使用默认实现） */
  tokenEstimator?: TokenEstimator;
  /** LLM 摘要调用函数（可选，用于压缩阶段） */
  summarize?: SummarizeFunction;
  /** 压缩进度回调（可选；UI / 可观测） */
  emit?: ContextEmitFn;
  /**
   * 从持久层加载压缩状态快照（进程重启恢复）。
   * 引擎内存态为空时调用一次。
   */
  loadCompactState?: (
    sessionId: string,
  ) => Promise<ContextCompactSnapshot | undefined> | ContextCompactSnapshot | undefined;
}

/**
 * 可持久化的压缩状态快照
 *
 * 与全量 messages 并存：Session 只追加完整日志；
 * 本快照用于重启后快速重建「应给 LLM 的视图」，避免立刻再打一次摘要。
 */
export interface ContextCompactSnapshot {
  /** 语义摘要正文（previousSummary；机械降级占位说明不算，不入快照） */
  summary?: string;
  /** 上次主动压缩时的全量消息条数（再压缩增长门；≠摘要覆盖终点） */
  lastProactiveMessageCount?: number;
  /**
   * 摘要覆盖终点（下标，不含）= tailStart。
   * sticky 增量起点；写成 messages.length 会把 tail 误算进覆盖 → 滑出丢消息。
   */
  lastProactiveCoverEnd?: number;
  /** 上次主动压缩后的视图 token 估算 */
  lastProactiveTokens?: number;
}

/**
 * 摘要调用函数
 *
 * 由 Harness 层注入，ContextEngine 用它调用 LLM 生成摘要。
 * 这样 ContextEngine 不直接依赖 ModelProvider，保持解耦。
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
  }
) => Promise<string>;

// ── 组装结果 ──

export interface AssembleResult {
  /** 组装好的 LLM 消息 */
  messages: LLMMessage[];
  /** 实际 token 数（由 TokenEstimator 提供） */
  estimatedTokens: number;
  /** 系统提示词（可能被修改） */
  systemPrompt: string;
  /** 被丢弃/压缩的信息摘要（告诉模型"你失去了什么"） */
  droppedSummary?: string;
  /**
   * 当前会话压缩摘要正文（previousSummary）。
   * 供调用方写回 Session 持久化；无摘要时为 undefined。
   */
  summary?: string;
  /** 可持久化压缩状态快照（含 lastProactiveMessageCount 等） */
  compactState?: ContextCompactSnapshot;
  /** 不可信内容范围 */
  untrustedRanges?: Array<{ start: number; end: number; source: string }>;
}

// ── 摄入参数 ──

export interface IngestParams {
  sessionId: string;
  message: Message;
}

// ── 压缩结果 ──

export interface CompactResult {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  tokensBefore: number;
  tokensAfter?: number;
  summary?: string;
  /**
   * 摘要覆盖终点（下标，**不含**）= tailStart。
   * sticky 重建的增量起点；写 `messages.length` 会把 tail 误算进覆盖 → 滑出后丢消息。
   */
  coveredMessageCount?: number;
}

// ── 轮次后参数 ──

export interface AfterTurnParams {
  sessionId: string;
  /** E4: compact key component; engine state key falls back to sessionId when omitted */
  agentId?: string;
  /** 本轮消息 */
  turn: Message[];
  /** 本轮 token 使用（cache-aware） */
  usage?: import('@octopi-agent/core/types/turn.js').TokenUsage;
}

// ── 引擎接口 ──

/**
 * ContextEngine — 上下文管理引擎
 *
 * 职责：在有限的上下文窗口内，为模型提供最有价值的信息。
 *
 * 核心方法：
 * - assemble(): 组装上下文（必须实现）
 *
 * 可选方法：
 * - ingest(): 存储消息
 * - afterTurn(): 更新状态（turn 为**本轮增量**消息）
 *
 * 本域契约（@layer harness/context）；Harness 提供 DefaultContextEngine。
 */
export interface ContextEngine {
  readonly info: ContextEngineInfo;

  /**
   * 组装上下文
   *
   * 核心方法。根据 token 预算，选择最有价值的信息组装成 LLM 上下文。
   * 包括：消息选择、压缩、截断、格式转换。
   *
   * @returns 组装好的 LLM 消息 + 元数据
   */
  assemble(params: AssembleParams): Promise<AssembleResult>;

  /**
   * 存储消息（可选）
   *
   * 将新消息存入引擎的内部存储。
   * 某些引擎（如外部服务）可能需要这一步。
   */
  ingest?(params: IngestParams): Promise<void>;

  /**
   * 每轮结束后更新状态（可选）
   *
   * 用于更新内部统计、触发异步压缩等。
   */
  afterTurn?(params: AfterTurnParams): Promise<void>;
}

// ── 组件接口（Harness 层可替换） ──

// ── 消息选择器 ──

export interface SelectResult {
  /** 要保留的消息 */
  kept: Message[];
  /** 溢出的消息（需要压缩） */
  overflow: Message[];
  /** 尾部保护的消息 */
  tail: Message[];
  /** 尾部 token 数 */
  tailTokens: number;
  /** 估算的总 token 数 */
  estimatedTokens: number;
  /** 溢出的 token 数 */
  overflowTokens: number;
}

export interface SelectOptions {
  maxTokens: number;
  protectFirstN: number;
  protectLastN: number;
}

export interface MessageSelector {
  select(messages: Message[], options: SelectOptions, tokenEstimator?: TokenEstimator): SelectResult;
}

// ── 压缩器 ──

export interface CompressParams {
  messages: Message[];
  targetTokens: number;
  previousSummary?: string;
  summarize?: SummarizeFunction;
  tokenEstimator?: TokenEstimator;
  /**
   * 要求产出语义摘要：设置后，机械截断（旧工具输出截断/兜底截断）即使已达标
   * 也不得就此短路返回——必须尝试摘要级。主动摘要路径（applyProactiveCompact）使用：
   * 否则压缩成功但永不产摘要，状态机的复用分支永远无法启用。
   *
   * 实现约定：仅约束「可摘要时不得走机械短路」；无摘要能力（如无 summarize）时
   * 的机械降级结果是允许的，调用方以「结果中无语义摘要」识别降级
   * （见 DefaultContextEngine.extractSummaryText）。
   */
  requireSummary?: boolean;
  /**
   * 缓存前缀：与会话 LLM 请求**同形**的 system+history（buildLlmMessages 产物）。
   * 摘要请求只许在其**尾部**追加指令；禁止改 system / 历史字节——否则打穿 provider 前缀缓存。
   */
  llmPrefix?: LLMMessage[];
}

export interface CompressResult {
  /** 压缩后的消息/摘要 */
  result: Message[];
  /** 估算 token 数 */
  estimatedTokens: number;
  /** 被丢弃的信息摘要 */
  droppedSummary?: string;
}

export interface Compressor {
  compress(params: CompressParams): Promise<CompressResult>;
}

// ── 预算分配器 ──

export interface BudgetAllocateParams {
  /** 可用 token 预算；未知窗口时可省略（见 budget-allocator） */
  tokenBudget?: number;
  contextWindow?: number;
  systemPromptTokens: number;
  toolTokens: number;
}

export interface BudgetAllocateResult {
  /** 消息可用的 token 预算 */
  messagesBudget: number;
  /** 预留给模型输出的 token */
  outputReserve: number;
}

export interface BudgetAllocator {
  allocate(params: BudgetAllocateParams): BudgetAllocateResult;
}
