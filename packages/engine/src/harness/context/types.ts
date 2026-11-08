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
import type { SummarizeFunction } from './capabilities/compact/types.js';

export type { LLMMessage, LLMToolDefinition };
/** 族 A 摘要执行契约：单源定义在 capabilities/compact/types.ts（此处再导出保持域内引用面稳定）。 */
export type { SummarizeFunction };

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

/** 压缩原因：主动摘要 vs 硬溢出 vs 手动（m-2：manual 事件显式带 reason，防 store 沿用旧标签） */
export type ContextCompactReason = 'proactive' | 'overflow' | 'manual';

/**
 * 上下文压缩可观测事件
 *
 * 由 ContextEngine 在同步压缩前后发出，供 UI 显示「正在压缩上下文…」，
 * 避免 LLM 摘要耗时被误判为会话卡死。失败不中断本轮（引擎回退截断）。
 */
export interface ContextCompactEvent {
  type:
    | 'context.compact.start'
    | 'context.compact.progress'
    | 'context.compact.end'
    | 'context.compact.error'
    | 'context.compact.summarize_fallback';
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
  /** 中止收尾（本轮作废、零写入）——不是「压缩完成」，UI 不得显示 compacted */
  cancelled?: boolean;
  /** summarize_fallback：cache-miss 旁路原因（no_prefix | window_guard | window_exhausted，F22） */
  fallback?: string;
  error?: string;
  /** error 的性质：denied = before_compaction 策略拒绝（不是故障）；failed = 压缩失败 */
  kind?: 'denied' | 'failed';
  /** progress：当前阶段（summarize = 摘要请求已发出、等 provider 返回） */
  phase?: 'summarize';
  /** progress：摘要请求体量（JSON 字符数） */
  requestChars?: number;
  /** progress：摘要请求消息条数 */
  requestMessages?: number;
  /** progress：本次摘要调用预算（ms）；缺失 = 不设预算 */
  timeoutMs?: number;
}

/** 事件回调（Builder 注入 → EventBus） */
export type ContextEmitFn = (event: ContextCompactEvent | OverflowAlertEvent) => void;

/**
 * overflow 症状告警（P3，arch/overflow-redesign.md §2.3 + 红线 7）
 *
 * 守门人触发 = 罕见异常信号，每次触发打告警（不当日常）：
 * - `proactive_failed`（A 类症状）：前馈溢出——proactive 本该在到达窗口前压缩
 * - `config_drift` / `config_missing`（F 类，有实证）：contextWindow 配置漂移/缺失
 * - `structural_over_budget`（D 类）：保护段超限——窗口连固定面都放不下
 * - `window_mismatch`（F 类，归因未定）：请求超真窗口但未提取到数字，配置或尺子偏差待查
 */
export interface OverflowAlertEvent {
  type: 'context.overflow.alert';
  sessionId: string;
  /** 症状语义（红线 7：前馈溢出必须含 proactive 失效语义） */
  symptom:
    | 'proactive_failed'
    | 'config_drift'
    | 'config_missing'
    | 'structural_over_budget'
    | 'window_mismatch';
  /** 人类可读告警（含症状语义关键词，UI/日志直接展示） */
  message: string;
  /** 触发时的估算 token（可选） */
  estimatedTokens?: number;
  /** 窗口值（配置或真值，可选） */
  contextWindow?: number;
  /** 触发入口：T1 前馈溢出 / T2 反馈溢出（F 类回填）/ T3 保护段超限 */
  trigger?: 'T1' | 'T2' | 'T3';
}

export interface AssembleParams {
  /** Session ID */
  sessionId: string;
  /** Agent ID（E4 compact 键分量；缺省时引擎状态退化为纯 sessionId） */
  agentId?: string;
  /** provider/model 标识（P1-a 校准 ratio 分键，如 `mock/m`；缺省时校准归入 'unknown'） */
  modelKey?: string;
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
  /** 模型 max_output_tokens（评审 F8R-04）：摘要硬顶按输出上限钳制，防自动路径顶穿被 400 */
  maxOutputTokens?: number;
  /**
   * 显式压缩目标 token（context.compactTargetTokens）。
   * 与 contextWindow 无关；未知窗口时仍可作手动/结构压缩的目标。
   */
  compactTargetTokens?: number;
  /** 中止信号（run 中止 → 取消在飞摘要；P3 起由 Loop 经 convertToLlm 透传） */
  signal?: AbortSignal;
  /** Token 估算器（可选，未提供时使用默认实现）。**必须是未校准的原始估算器**——
   *  校准由引擎 ContextSizeLedger 统一施加，传入已校准包装会造成双重校准 */
  tokenEstimator?: TokenEstimator;
  /** LLM 摘要调用函数（可选，用于压缩阶段） */
  summarize?: SummarizeFunction;
  /**
   * 交接式摘要素材：当前会话 task 快照（B0：易变块走 content 尾部指令）。
   * 手动/自动（proactive/overflow）压缩路径统一透传给摘要请求（F8R-05），
   * 使自动路径不再依赖注入历史里的旧快照副本。
   */
  taskSnapshot?: string;
  /** 压缩进度回调（可选；UI / 可观测） */
  emit?: ContextEmitFn;
  /**
  /**
   * 旧压缩快照读口（ContextCompactSnapshot，迁移输入）：转换记录账本为空且快照
   * 存在时一次性迁移为初始记录（幂等）。迁移后快照不再更新。
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
   * 当前会话压缩摘要正文（最新 summary 型转换记录的文本）。
   * 供调用方展示；无摘要时为 undefined。
   */
  summary?: string;
  /** estimatedTokens 的读数来源（pressure 快照可观测，评审 F5）：calibrated/anchored/raw */
  readingSource?: 'calibrated' | 'anchored' | 'raw';
  /** 不可信内容范围 */
  untrustedRanges?: Array<{ start: number; end: number; source: string }>;
}

// ── 摄入参数 ──

export interface IngestParams {
  sessionId: string;
  message: Message;
}

// ── 轮次后参数 ──

export interface AfterStepParams {
  sessionId: string;
  /** E4: compact key component; engine state key falls back to sessionId when omitted */
  agentId?: string;
  /** 本轮消息 */
  step: Message[];
  /** 本轮 token 使用（cache-aware） */
  usage?: import('@octopi-agent/core/types/step.js').TokenUsage;
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
 * - afterStep(): 更新状态（step 为**本轮增量**消息）
 *
 * 本域契约（@layer harness/context）；Harness 提供 DefaultContextEngine。
 */
export interface ContextEngine {
  /**
   * 校准状态快照（可选，持久化配套）：锚+样本计数导出——restore 后回填消除冷启动。
   * @returns per-key 样本计数与锚
   */
  exportCalibration?(): {
    samples: Record<string, { samples: number }>;
    anchors: Record<string, { actual: number; raw: number; modelKey: string }>;
  };
  /** 校准状态恢复（可选）：importCalibration 配对使用 */
  importCalibration?(data: {
    samples?: Record<string, { samples: number }>;
    anchors?: Record<string, { actual: number; raw: number; modelKey: string }>;
  }): void;
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
  afterStep?(params: AfterStepParams): Promise<void>;
}

// ── 组件接口（Harness 层可替换） ──

// ── 消息选择器 ──

export interface SelectResult {
  /** 要保留的消息。**身份契约**：必须是入参数组的同引用对象（转换记录按对象身份
   *  把产物翻译回原始区间；返回拷贝会让翻译失锚） */
  kept: Message[];
  /** 溢出的消息（需要压缩）。同上：同引用 */
  overflow: Message[];
  /** 尾部保护的消息。同上：同引用 */
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
  /**
   * 度量视图（可选）：与 `messages` **等长同序**，只用于 token 估算。
   *
   * 存在的理由（尺子与作用域同源）：实际请求发的是**老化视图**，而压缩必须吃
   * **原文**（F-b）。若用原文估算，老化越有效误判越大——原文 middle 797k /
   * 视图 76k 时会每请求判溢出、每请求触发一次摘要，把前缀缓存整段烧掉。
   * 切分仍按 `messages`（原文），仅估算看这里。
   */
  measureMessages?: Message[];
}

export interface MessageSelector {
  select(messages: Message[], options: SelectOptions, tokenEstimator?: TokenEstimator): SelectResult;
}

// ── 预算分配器 ──

export interface BudgetAllocateParams {
  /** 可用 token 预算；未知窗口时可省略（见 budget-allocator） */
  tokenBudget?: number;
  contextWindow?: number;
  /**
   * 模型单次输出上限（= 请求实际携带的 max_tokens 上界）。
   * 提供且物理窗口已知时，按硬预留计入 `outputReserve`——这是
   * `input + max_tokens ≤ contextWindow` 不变量的唯一保证。
   * 窗口未知（仅有 compactTargetTokens 等策略目标）时忽略：目标不是物理边界。
   */
  maxOutputTokens?: number;
  systemPromptTokens: number;
  toolTokens: number;
}

export interface BudgetAllocateResult {
  /**
   * 输入侧硬上限（不变量）：`system + tools + messages ≤ inputLimit`。
   * 恒有 `inputLimit + outputReserve ≤ effectiveLimit`。
   */
  inputLimit: number;
  /**
   * 消息侧硬上限 = `inputLimit − system − tools − 请求信封`。
   * `MessageSelector` / overflow 目标等**强制点**必须用这个值。
   */
  messagesLimit: number;
  /**
   * 消息侧软目标（压缩策略提示值，≤ messagesLimit）。
   * 触发压缩的阈值挂这里；它允许小于 messagesLimit（提前压缩），
   * 但任何强制点不得用它当作边界。
   */
  messagesBudget: number;
  /** 预留给模型输出的 token（有 maxOutputTokens 时即其值） */
  outputReserve: number;
  /** 预算不可行：固定开销 + 输出预留已吃掉窗口（messagesLimit ≤ 0） */
  infeasible?: boolean;
}

export interface BudgetAllocator {
  allocate(params: BudgetAllocateParams): BudgetAllocateResult;
}
