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
}

/**
 * 核心消息结构
 */
export interface Message {
  /** 消息角色 */
  role: MessageRole;
  /** 消息内容（文本） */
  content: string;
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
 * 模型配置
 */
export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
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
// 7. LLM Provider（向后兼容）
// ============================================================

/**
 * LLM 请求（向后兼容）
 */
export interface LLMRequest {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: unknown[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

/**
 * LLM 响应（向后兼容）
 */
export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  model: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

/**
 * LLM Provider 接口（向后兼容）
 */
export interface LLMProvider {
  name: string;
  models: string[];
  complete(request: LLMRequest): Promise<LLMResponse>;
  stream?(request: LLMRequest): AsyncIterable<LLMResponse>;
  healthCheck?(): Promise<boolean>;
}

// ============================================================
// 8. Channel Adapter
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
// 9. Plugin Hooks
// ============================================================

export interface HookContext {
  sessionId: string;
  agentId: string;
  [key: string]: unknown;
}

// ============================================================
// 10. Agent Event（向后兼容）
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

export type AgentEvent =
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
// 11. Error Classification
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
// 12. Context Engine（向后兼容）
// ============================================================

export interface AssembleResult {
  messages: Array<Record<string, unknown>>;
  estimatedTokens: number;
  systemPromptAddition?: string;
}

export interface CompactResult {
  ok: boolean;
  compacted: boolean;
  sessionId?: string;
  sessionFile?: string;
}

export interface ContextEngineInfo {
  id: string;
  name: string;
  ownsCompaction: boolean;
}

export interface ContextEngine {
  info: ContextEngineInfo;
  ingest(params: { sessionId: string; message: Message }): Promise<void>;
  assemble(params: {
    sessionId: string;
    messages: Message[];
    tokenBudget: number;
    availableTools: string[];
  }): Promise<AssembleResult>;
  compact(params: { sessionId: string; force: boolean }): Promise<CompactResult>;
  afterTurn(params: { sessionId: string; turn: Turn }): Promise<void>;
}

// ============================================================
// 13. Gateway 配置
// ============================================================

export interface GatewayConfig {
  port?: number;
  agents: AgentDefinition[];
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
}

// ============================================================
// 14. Message Converter
// ============================================================

export interface LLMMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface MessageConverter {
  toLlm(messages: Message[], stripMeta?: boolean): LLMMessage[];
  fromLlm(message: LLMMessage): Message;
}

// ============================================================
// 15. Agent Loop Config（向后兼容）
// ============================================================

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface AgentLoopConfig {
  provider: LLMProvider;
  agentId: string;
  workspace?: string;
  systemPrompt?: string;
  contextEngine: ContextEngine;
  toolRegistry: {
    getDefinitions(): unknown[];
    execute(name: string, args: unknown, ctx: unknown): Promise<{ result?: unknown; error?: string }>;
  };
  messageConverter: MessageConverter;
  pluginManager?: import('../plugins/manager.js').PluginManager;
  skillManager?: SkillManager;
  defaultModel: string;
  maxTurns: number;
  iterationBudget: number;
  maxConsecutiveErrors: number;
  retry: RetryConfig;
  outputQuality?: import('../loop/output-quality-types.js').QualityGateConfig;
  recovery?: import('../loop/output-quality-types.js').RecoveryConfig;
  onEvent?: (event: AgentEvent) => void;
  onSteering?: () => Promise<Message[]>;
}

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

// ============================================================
// 16. Queue Mode
// ============================================================

/** 队列模式 */
export type QueueMode = 'steer' | 'followup' | 'collect' | 'interrupt';

// ============================================================
// 17. Thinking Level
// ============================================================

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';
