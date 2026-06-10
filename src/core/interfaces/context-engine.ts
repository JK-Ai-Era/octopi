/**
 * ContextEngine — 上下文管理引擎接口
 *
 * 职责：在有限的上下文窗口内，为模型提供最有价值的信息。
 *
 * 核心方法：
 * - assemble(): 组装上下文（必须实现）
 *
 * 可选方法：
 * - ingest(): 存储消息
 * - compact(): 压缩存储
 * - afterTurn(): 更新状态
 *
 * Core 层定义接口，不包含任何策略逻辑。
 * Harness 层提供默认实现，Integration 层可完全替换。
 */

import type { Message, ToolCall } from '../types.js';
import type { LLMMessage, ToolDefinition } from './model-provider.js';

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
 * Core 层定义接口，Harness 层实现具体策略。
 */
export interface TokenEstimator {
  /** 估算单条消息的 token 数 */
  estimateMessage(message: Message): number;
  /** 估算多条消息的总 token 数 */
  estimateMessages(messages: Message[]): number;
  /** 估算文本的 token 数 */
  estimateText(text: string): number;
  /** 估算工具定义的 token 数 */
  estimateTools(tools: ToolDefinition[]): number;
}

// ── 组装参数 ──

export interface AssembleParams {
  /** Session ID */
  sessionId: string;
  /** 当前消息历史 */
  messages: Message[];
  /** 系统提示词 */
  systemPrompt: string;
  /** 可用工具定义 */
  tools: ToolDefinition[];
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
 * - afterTurn(): 更新状态
 *
 * Core 层定义接口，不包含任何策略逻辑。
 * Harness 层提供默认实现，Integration 层可完全替换。
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
