/**
 * Octopi 核心类型定义
 *
 * v2.0 — 重构后保留所有原有类型，新增三层架构所需类型。
 *
 * 设计原则：
 * 1. Agent 不是一个 class，而是一个完整的 scope
 * 2. Session 是一等公民，有完整的生命周期管理
 * 3. Core 层是无状态的循环引擎
 * 4. 安全是内置的，不是附加的
 */

// ============================================================
// 1. 消息系统
// ============================================================

/**
 * 消息角色
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * 消息来源信息
 */
export interface MessageSource {
  /** 渠道名称（如 feishu、telegram、http） */
  channel: string;
  /** 发送者 ID */
  senderId?: string;
  /** 发送者显示名 */
  senderName?: string;
  /** 原始消息 ID */
  messageId?: string;
  /** 会话 ID（渠道侧） */
  conversationId?: string;
}

// ── 多模态内容块 ──

/**
 * 文本内容块
 */
export interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * 图片内容块
 */
export interface ImageBlock {
  type: 'image';
  /** 图片 URL（http/https 或 data URI） */
  url?: string;
  /** Base64 编码的图片数据 */
  data?: string;
  /** MIME 类型（如 image/png, image/jpeg） */
  mimeType?: string;
  /** 图片描述（可选，用于无障碍和日志） */
  alt?: string;
}

/**
 * 音频内容块
 */
export interface AudioBlock {
  type: 'audio';
  /** 音频 URL */
  url?: string;
  /** Base64 编码的音频数据 */
  data?: string;
  /** MIME 类型（如 audio/mp3, audio/wav） */
  mimeType?: string;
  /** 音频时长（秒） */
  durationSeconds?: number;
}

/**
 * 视频内容块
 */
export interface VideoBlock {
  type: 'video';
  /** 视频 URL */
  url?: string;
  /** Base64 编码的视频数据 */
  data?: string;
  /** MIME 类型（如 video/mp4） */
  mimeType?: string;
  /** 视频时长（秒） */
  durationSeconds?: number;
}

/**
 * 文件内容块
 */
export interface FileBlock {
  type: 'file';
  /** 文件 URL */
  url?: string;
  /** Base64 编码的文件数据 */
  data?: string;
  /** 文件名 */
  name?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 文件大小（字节） */
  sizeBytes?: number;
}

/**
 * 内容块联合类型
 *
 * 支持多模态消息：文本、图片、音频、视频、文件。
 * 向后兼容：Message.content 仍可以是纯字符串。
 */
export type ContentBlock = TextBlock | ImageBlock | AudioBlock | VideoBlock | FileBlock;

/**
 * 工具调用请求（LLM 返回的 tool_calls）
 */
export interface ToolCall {
  /** 调用 ID（用于关联 tool result） */
  id: string;
  /** 工具名称 */
  name: string;
  /** 工具参数 */
  arguments: Record<string, unknown>;
}

/**
 * 工具执行结果
 */
export interface ToolResult {
  /** 关联的 tool call ID */
  toolCallId: string;
  /** 工具名称 */
  name: string;
  /** 执行结果 */
  result: unknown;
  /** 错误信息（执行失败时） */
  error?: string;
  /** 执行耗时（毫秒） */
  durationMs?: number;
  /** 标记为无操作（内容未变化），用于检测 tool-loop 死循环 */
  noop?: boolean;
}

/**
 * 核心消息结构
 *
 * 支持多模态内容：content 可以是纯字符串（向后兼容）或 ContentBlock 数组。
 */
export interface Message {
  /** 消息角色 */
  role: MessageRole;
  /** 消息内容：纯字符串（向后兼容）或多模态内容块数组 */
  content: string | ContentBlock[];
  /** 消息来源（user 消息才有） */
  source?: MessageSource;
  /** LLM 请求的工具调用（assistant 消息才有） */
  toolCalls?: ToolCall[];
  /** 工具执行结果（tool 消息才有） */
  toolResults?: ToolResult[];
  /** 时间戳 */
  timestamp: number;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 从消息内容中提取纯文本
 *
 * 向后兼容工具：处理 string 和 ContentBlock[] 两种格式。
 */
export function getTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('');
}

/**
 * 检查消息内容是否包含非文本块（图片、音频等）
 */
export function hasMediaContent(content: string | ContentBlock[]): boolean {
  if (typeof content === 'string') return false;
  return content.some(block => block.type !== 'text');
}

// ============================================================
// 2. Agent 定义
// ============================================================

/**
 * Agent 人设
 */
export interface AgentPersona {
  name: string;
  description: string;
  systemPrompt: string;
  tags?: string[];
}

/**
 * 模型能力声明
 *
 * 描述模型的固有能力（不是请求参数）。
 * 用于 Context Pipeline 的 token 预算规划和智能路由。
 */
export interface ModelInfo {
  /** 模型名称 */
  name: string;
  /** 上下文窗口大小（token 数） */
  contextWindow?: number;
  /** 最大输出 token 数 */
  maxOutputTokens?: number;
}

/**
 * 模型配置
 *
 * 注意区分：
 * - maxTokens: 请求参数，"我要多少 token"
 * - ModelInfo.maxOutputTokens: 能力声明，"模型最多给多少"
 * - ModelInfo.contextWindow: 能力声明，"模型能处理多少上下文"
 */
export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  /** 请求的最大输出 token 数（请求参数，不是模型能力） */
  maxTokens?: number;
  fallbackModels?: string[];
}

/**
 * 工具策略
 */
export interface ToolPolicy {
  allow: string[];
  deny?: string[];
  requireConfirmation?: string[];
}

/**
 * Agent 定义
 */
export interface AgentDefinition {
  id: string;
  workspace: string;
  persona: AgentPersona;
  tools: ToolPolicy;
  model: ModelConfig;
  skillDirectory?: string;
  skills?: string[];
  contextEngine?: string;
  channelBindings?: Record<string, string>;
}

// ============================================================
// 3. Session
// ============================================================

/**
 * Session 状态
 */
export type SessionStatus = 'idle' | 'processing' | 'waiting_human' | 'error';

/**
 * Session 元数据
 */
export interface SessionMeta {
  id: string;
  agentId: string;
  channelId: string;
  peerId: string;
  status: SessionStatus;
  createdAt: number;
  sessionStartedAt: number;
  lastInteractionAt: number;
  updatedAt: number;
}

// ============================================================
// 4. Turn
// ============================================================

/**
 * Token 使用量
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Turn — 一次完整的 Agent 调用
 */
export interface Turn {
  id: string;
  input: Message[];
  output: Message;
  usage?: TokenUsage;
  durationMs: number;
  model: string;
  timestamp: number;
}

// ============================================================
// 5. 工具系统
// ============================================================

/**
 * 工具参数定义
 */
export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  enum?: string[];
  properties?: Record<string, ToolParameter>;
  items?: ToolParameter;
  default?: unknown;
}

/**
 * 工具定义
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  permissions?: string[];
  requiresConfirmation?: boolean;
  timeoutMs?: number;
}

/**
 * 工具执行上下文
 */
export interface ToolExecutionContext {
  sessionId: string;
  agentId: string;
  messages: Message[];
  abortSignal?: AbortSignal;
  /** 当前工作目录 */
  cwd?: string;
}

/**
 * 工具处理函数
 */
export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<unknown>;

/**
 * 已注册的工具
 */
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// ============================================================
// 6. Skill 系统
// ============================================================

/**
 * Skill 定义
 */
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  filePath: string;
  source: 'bundled' | 'workspace' | 'plugin';
  disableModelInvocation?: boolean;
  requiredTools?: string[];
}

/**
 * Skill 管理器接口
 */
export interface SkillManager {
  discover(directory: string): Promise<void>;
  formatForPrompt(): string;
  load(skillId: string): Promise<string | null>;
  list(): SkillDefinition[];
  get(skillId: string): SkillDefinition | null;
}

// ============================================================
// 7. Channel Adapter
// ============================================================

export interface ChannelMessage {
  id: string;
  channel: string;
  senderId: string;
  senderName?: string;
  content: string;
  conversationId: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ChannelReply {
  channel: string;
  conversationId: string;
  content: string;
  replyToId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelAdapter {
  name: string;
  start(handler: (msg: ChannelMessage) => Promise<void>): Promise<void>;
  send(reply: ChannelReply): Promise<void>;
  stop(): Promise<void>;
}

// ============================================================
// 8. Plugin Hooks
// ============================================================

export interface HookContext {
  sessionId: string;
  agentId: string;
  [key: string]: unknown;
}

// ============================================================
// 9. Agent Event
// ============================================================

export type LoopEndReason =
  | 'completed'
  | 'max_turns'
  | 'budget_exhausted'
  | 'plugin_stop'
  | 'interrupted'
  | 'error';

export interface LLMStreamChunk {
  type: 'content' | 'thinking';
  text: string;
}

export type AgentEventDetail =
  | { type: 'loop_start'; sessionId: string }
  | { type: 'loop_end'; reason: LoopEndReason; response?: string }
  | { type: 'turn_start'; turnId: string; turnIndex: number }
  | { type: 'turn_end'; turnId: string; shouldContinue: boolean }
  | { type: 'messages_injected'; count: number; source: string }
  | { type: 'llm_request'; model: string; estimatedTokens: number }
  | { type: 'llm_thinking_delta'; delta: string }
  | { type: 'llm_stream_delta'; delta: string }
  | { type: 'llm_response'; content: string; toolCalls?: ToolCall[]; usage?: TokenUsage; durationMs: number }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; arguments: string }
  | { type: 'tool_call_result'; toolCallId: string; toolName: string; result: string; durationMs?: number }
  | { type: 'tool_call_error'; toolCallId: string; toolName: string; error: string }
  | { type: 'error'; error: ClassifiedError; retrying: boolean }
  | { type: 'retry_wait'; attempt: number; maxRetries: number; waitMs: number }
  | { type: 'context_compressed'; beforeTokens: number; afterTokens: number }
  | { type: 'interrupt_requested' }
  | { type: 'interrupted'; phase: string }
  | { type: 'quality_anomaly'; checkResult: unknown; classification: unknown; strategy: string }
  | { type: 'model_change'; model: string; reason: string }
  | { type: 'degrade_mode'; reason: string; config: unknown };

// ============================================================
// 10. Error Classification
// ============================================================

export type ErrorReason =
  | 'rate_limit'
  | 'context_length'
  | 'auth'
  | 'billing'
  | 'network'
  | 'timeout'
  | 'server'
  | 'unknown';

export interface ClassifiedError {
  reason: ErrorReason;
  provider?: string;
  model?: string;
  statusCode?: number;
  retryAfterMs?: number;
  message: string;
  originalError: unknown;
}

// ============================================================
// 11. Context Engine
// ============================================================

// ContextEngine 类型已移至 core/interfaces/context-engine.ts
// 保留向后兼容的导出
export type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
} from './interfaces/context-engine.js';

// ============================================================
// 12. Gateway 配置
// ============================================================

export interface GatewayConfig {
  port?: number;
  agents: AgentDefinition[];
  budget?: {
    maxIterations?: number;
    maxToolCalls?: number;
    maxTokens?: number;
    maxWallClockMs?: number;
  };
  session?: {
    dmScope?: 'main' | 'per-peer' | 'per-channel-peer';
    reset?: {
      dailyHour?: number;
      idleMinutes?: number;
    };
    maintenance?: {
      mode?: 'warn' | 'enforce';
      pruneAfter?: string;
      maxEntries?: number;
    };
  };
  /** 可观测性配置 */
  trace?: {
    /** trace 输出目录（默认 ~/.octopi/traces） */
    outputDir?: string;
    /** 日志级别（默认 INFO） */
    level?: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE';
    /** 是否捕获工具参数（默认 true） */
    captureToolArgs?: boolean;
    /** 是否捕获工具结果（默认 true） */
    captureToolResults?: boolean;
  };
  /**
   * 模型调用空闲超时（毫秒，默认 120000）
   *
   * 引擎层 watchdog：provider 没有产出数据的最大等待时间。
   * 保证引擎不会无限阻塞在 provider 的 reader.read()。
   */
  modelCallIdleTimeoutMs?: number;
}

export type AgentEventListener = (event: AgentEventDetail) => void | Promise<void>;

// ============================================================
// 13. Queue Mode
// ============================================================

/** 队列模式 */
export type QueueMode = 'steer' | 'followup' | 'collect' | 'interrupt';

// ============================================================
// 14. Thinking Level
// ============================================================

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';
