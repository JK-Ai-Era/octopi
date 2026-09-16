/**
 * ContextEngine — 上下文装配契约
 *
 * @layer harness/context — 产品端口（非 Core Kernel）。
 * 在有限上下文窗口内为模型选择/压缩最有价值的信息。
 *
 * 接入：Builder 经 convertToLlm 调用 assemble；Loop 不依赖本类型。
 */

import type { Message, ToolCall } from '../../core/types.js';
import type { LLMMessage, LLMToolDefinition } from '../../core/interfaces/model-provider.js';

export type { LLMMessage, LLMToolDefinition };

// ── 引擎信息 ──

export interface ContextEngineInfo {
  /** 引擎唯一标识 */
  id: string;
  /** 引擎名称 */
  name: string;
  /** 是否拥有压缩能力（外部引擎可能自行管理） */
  ownsCompaction: boolean;
}

// ── Token 估算 ──

/**
 * Token 估算器
 *
 * 负责估算内容的 token 数。
 * 策略：
 * 1. 优先使用 LLM 返回的实际 token 数（usage.promptTokens）
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
  /** 当前消息历史 */
  messages: Message[];
  /** 系统提示词 */
  systemPrompt: string;
  /** 可用工具定义 */
  tools: LLMToolDefinition[];
  /** Token 预算（可用空间） */
  tokenBudget: number;
  /** 模型上下文窗口大小（来自 ModelInfo） */
  contextWindow?: number;
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
  /** 摘要正文（previousSummary） */
  summary?: string;
  /** 上次主动摘要时的全量消息条数 */
  lastProactiveMessageCount?: number;
  /** 上次主动摘要后的视图 token 估算 */
  lastProactiveTokens?: number;
}

/**
 * 摘要调用函数
 *
 * 由 Harness 层注入，ContextEngine 用它调用 LLM 生成摘要。
 * 这样 ContextEngine 不直接依赖 ModelProvider，保持解耦。
 *
 * @param messages - 要摘要的消息
 * @param options - 摘要选项
 * @returns 摘要文本
 */
export type SummarizeFunction = (
  messages: LLMMessage[],
  options?: {
    /** 上次摘要（用于迭代式更新） */
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

// ── 压缩参数 ──

export interface CompactParams {
  sessionId: string;
  /** Token 预算 */
  tokenBudget: number;
  /** 是否强制压缩 */
  force?: boolean;
  /** 当前 token 数（可选，避免重复计算） */
  currentTokenCount?: number;
}

// ── 压缩结果 ──

export interface CompactResult {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  tokensBefore: number;
  tokensAfter?: number;
  summary?: string;
}

// ── 轮次后参数 ──

export interface AfterTurnParams {
  sessionId: string;
  /** 本轮消息 */
  turn: Message[];
  /** 本轮 token 使用 */
  usage?: { promptTokens: number; completionTokens: number };
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
 * - compact(): 压缩存储
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
   * 压缩存储（可选）
   *
   * 当存储超限时，压缩旧消息。
   * 引擎可以选择摘要、截断、外部存储等方式。
   */
  compact?(params: CompactParams): Promise<CompactResult>;

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
  tokenBudget: number;
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
