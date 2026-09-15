/**
 * Agent Loop v3 核心类型定义
 *
 * 设计原则：
 * 1. 核心循环只处理 LLM 协议层边界情况（截断、超时、中止）
 * 2. 所有"模型行为异常"的判断和处理都是策略，放 Harness 层
 * 3. 消息格式通过 convertToLlm 回调与 LLM 格式解耦
 * 4. 工具系统支持并行/串行、参数预处理、流式更新
 */

import type { Message, ToolCall, ToolResult, TokenUsage } from '../core/types.js';
import type {
  ModelProvider,
  LLMMessage,
  LLMResponse,
  LLMStreamChunk,
  LLMToolDefinition,
} from '../core/interfaces/model-provider.js';

// ============================================================
// 1. Agent 上下文（循环工作区）
// ============================================================

/**
 * Agent 上下文 — agentLoop 的输入状态
 *
 * 注意：这是**可变工作区**，不是不可变快照。
 * agentLoop 会原地修改 `messages`（system 托管、assistant/tool 追加、transformContext 赋值）。
 * Harness `Agent` 持有同一引用；Runner 在 run 结束后把 `context.messages` 同步回 Session。
 */
export interface AgentContext {
  /** 系统提示词（引擎托管 system 的权威来源） */
  systemPrompt: string;
  /** 消息历史（循环内原地修改） */
  messages: Message[];
  /** 可用工具列表 */
  tools?: AgentTool[];
}

// ============================================================
// 2. 工具系统
// ============================================================

/**
 * Agent 工具定义
 *
 * 对齐 Pi 的 AgentTool：支持参数预处理、校验、并行/串行、流式更新。
 */
export interface AgentTool {
  name: string;
  description: string;
  /** UI 显示名（可选，默认用 name） */
  label?: string;
  parameters?: LLMToolDefinition['function']['parameters'];

  // ── 参数处理 ──
  /** 参数预处理（在 beforeToolCall 之前执行） */
  prepareArguments?: (args: unknown) => unknown;
  /** 参数校验（在 prepareArguments 之后执行） */
  validate?: (args: unknown) => { valid: boolean; error?: string };

  // ── 执行 ──
  /** 工具执行函数 */
  execute: (
    toolCallId: string,
    args: unknown,
    signal?: AbortSignal,
    onUpdate?: (partialResult: Partial<LoopToolResult>) => void,
  ) => Promise<LoopToolResult>;

  // ── 执行模式 ──
  /** 单工具粒度的执行模式覆盖。默认使用 AgentLoopConfig.toolExecution */
  executionMode?: 'parallel' | 'sequential';
}

/**
 * 工具结果（Agent Loop 专用，与 types.ts 的 ToolResult 区分）
 */
export interface LoopToolResult {
  toolCallId: string;
  name: string;
  content: unknown;
  isError?: boolean;
  durationMs?: number;
  /** 标记为 no-op（未产生实际变化），Harness 层用于循环检测 */
  noop?: boolean;
  /**
   * 提示 agent 应在当前工具批次后停止。
   * 不变量：批次内**所有**结果 terminate=true 时，agentLoop 以
   * `agent_end(reason='should_stop')` 干净结束。
   */
  terminate?: boolean;
}

// ============================================================
// 3. 错误分类
// ============================================================

// ── 错误分类（规范定义在 interfaces/error-strategy.ts） ──
import type { ErrorReason, ClassifiedError } from '../core/interfaces/error-strategy.js';
export type { ErrorReason, ClassifiedError } from '../core/interfaces/error-strategy.js';

// ============================================================
// 4. 回调类型
// ============================================================

/** beforeToolCall 上下文 */
export interface BeforeToolCallContext {
  toolCall: ToolCall;
  args: unknown;
  context: AgentContext;
}

/** beforeToolCall 返回值 */
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
  /** 阻止时是否应终止整个 agent 循环（默认 false） */
  terminate?: boolean;
}

/** beforeToolCall 回调 */
export type BeforeToolCallFn = (
  ctx: BeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

/** afterToolCall 上下文 */
export interface AfterToolCallContext {
  toolCall: ToolCall;
  args: unknown;
  result: LoopToolResult;
  context: AgentContext;
}

/** afterToolCall 返回值 */
export interface AfterToolCallResult {
  content?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

/** afterToolCall 回调 */
export type AfterToolCallFn = (
  ctx: AfterToolCallContext,
  signal?: AbortSignal,
) => Promise<AfterToolCallResult | undefined>;

/** 轮次上下文 */
export interface TurnContext {
  message: Message;
  toolResults: LoopToolResult[];
  context: AgentContext;
}

/** shouldStopAfterTurn 回调 */
export type ShouldStopAfterTurnFn = (ctx: TurnContext) => Promise<boolean>;

/** onTurnComplete 回调（Harness 内部使用，做副作用，不控制停止） */
export type OnTurnCompleteFn = (ctx: TurnContext) => Promise<void>;

/** 轮次配置更新 */
export interface TurnUpdate {
  /**
   * 下一轮上下文。若传入**新对象**，Loop 只会把字段合并回原 context 引用
   * （Agent 持有同一对象），不会替换引用。
   */
  context?: AgentContext;
  model?: ModelProvider;
}

/** prepareNextTurn 回调 */
export type PrepareNextTurnFn = (ctx: TurnContext) => Promise<TurnUpdate | undefined>;

/**
 * onError 回调（接收已分类的错误）
 *
 * 不变量：agentLoop 对 LLM 业务失败**永不 throw**。任何终止路径都先
 * yield `agent_end`（reason: 'error'），generator 正常结束，保证 UI/事件
 * 消费方总能看到终态。需要异常控制流的调用方应在自己的包装层根据
 * `agent_end` 自行 throw。
 *
 * - `retry`  — 重试当前迭代（yield 一条 error turn_end 后 continue）
 * - `abort` — 干净结束（yield agent_end reason='error' 后 return）
 */
export type OnErrorFn = (error: ClassifiedError) => Promise<'retry' | 'abort'>;

// ============================================================
// 5. Observer 接口（简化版）
// ============================================================

export interface LoopObserver {
  onLLMStart?(params: { model: string }): void;
  onLLMEnd?(params: { model: string; usage?: TokenUsage }): void;
  onToolStart?(params: { toolCall: ToolCall }): void;
  onToolEnd?(params: { toolCall: ToolCall; result: LoopToolResult }): void;
}

// ============================================================
// 6. AgentLoopConfig（按关注点拆分为子接口）
// ============================================================

/** 工具执行钩子配置 */
export interface ToolHooksConfig {
  /** 工具执行前：安全检查/拦截/参数修改。返回 { block: true } 阻止执行。 */
  beforeToolCall?: BeforeToolCallFn;
  /** 工具执行后：结果修改/日志/验证。 */
  afterToolCall?: AfterToolCallFn;
  /** 工具执行模式：parallel（默认）或 sequential */
  toolExecution?: 'parallel' | 'sequential';
}

/** 轮次控制钩子配置 */
export interface TurnHooksConfig {
  /** 用户层停止条件（始终被调用，返回 true 停止） */
  shouldStopAfterTurn?: ShouldStopAfterTurnFn;
  /** 轮次完成通知（Harness 内部，做副作用，不控制停止） */
  onTurnComplete?: OnTurnCompleteFn;
  /** 动态切换 model/context/thinkingLevel */
  prepareNextTurn?: PrepareNextTurnFn;
  /** 错误处理（接收已分类的错误） */
  onError?: OnErrorFn;
}

/**
 * Agent Loop 配置
 *
 * 核心循环的所有可配置行为都在这里。
 * 不包含可靠性机制（planningRetry、loopDetection 等），这些在 Harness 层。
 *
 * 按关注点拆分为子接口：
 * - ToolHooksConfig: 工具执行钩子
 * - TurnHooksConfig: 轮次控制钩子
 */
export interface AgentLoopConfig extends ToolHooksConfig, TurnHooksConfig {
  // ── 核心（唯一必需） ──
  model: ModelProvider;

  // ── 消息格式边界 ──
  /** 内部消息格式 → LLM 消息格式。不传则直接透传。 */
  convertToLlm?: (messages: Message[]) => Promise<LLMMessage[]>;

  // ── 上下文变换 ──
  /** LLM 调用前：压缩/注入/修改消息。在 convertToLlm 之前执行。 */
  transformContext?: (messages: Message[], signal?: AbortSignal) => Promise<Message[]>;

  // ── 消息队列（由 Harness / 调用方注入 get*Messages） ──
  /** 获取 steering 消息（当前 turn 结束后注入） */
  getSteeringMessages?: () => Promise<Message[]>;
  /** 获取 followUp 消息（agent 即将停止时注入） */
  getFollowUpMessages?: () => Promise<Message[]>;

  // ── 可观测性 ──
  observer?: LoopObserver;

  // ── 超时配置 ──
  /** 模型调用空闲超时（默认 120s） */
  modelCallIdleTimeoutMs?: number;
  /** 模型调用绝对超时（默认 300s） */
  modelCallAbsoluteTimeoutMs?: number;
}

// ============================================================
// 7. AgentEvent（核心循环事件）
// ============================================================

/**
 * 核心循环事件（Layer 0 协议词表）
 *
 * 仅包含 agentLoop / callModel 会产出的事件。
 * Harness 层扩展事件（budget_exceeded / run_guard_*）见
 * `harness/reliability/harness-events.ts` 的 `HarnessLoopEvent`。
 */
export type AgentLoopEvent =
  | { type: 'agent_start'; timestamp: number }
  | { type: 'agent_end'; reason: 'completed' | 'aborted' | 'error' | 'should_stop'; timestamp: number; error?: unknown }
  | { type: 'turn_start'; timestamp: number }
  /**
   * 一轮 LLM 结束。
   *
   * `phase` 显式标记时序，避免上层踩坑：
   * - `pre_tools`：本轮返回了 tool_calls，工具**即将**执行（token/usage 已入账）
   * - `final`：本轮无工具路径结束（纯文本 / followUp / 截断回灌 / 错误重试）
   *
   * 不变量：工具路径下 `turn_end(phase=pre_tools)` 之后**不会**再补一条 final
   * turn_end；终止（terminate / should_stop）直接 `agent_end`。
   */
  | {
      type: 'turn_end';
      hasToolCalls: boolean;
      phase: 'pre_tools' | 'final';
      truncated?: boolean;
      stopped?: boolean;
      error?: boolean;
      usage?: TokenUsage;
    }
  | { type: 'assistant_message'; message: Message; timestamp: number }
  | { type: 'llm_stream_delta'; timestamp: number; data: { delta: string } }
  | { type: 'tool_start'; toolCall: ToolCall; timestamp: number }
  | { type: 'tool_end'; toolCall: ToolCall; result: LoopToolResult; timestamp: number }
  | { type: 'stream.fallback_to_sync'; timestamp: number; data: { reason: string } }
  | { type: 'stream.fallback_failed'; timestamp: number; data: { error: string } };
