/**
 * Agent Harness 核心类型定义
 *
 * 设计原则：
 * - 接口优先，实现后置
 * - 类型是文档，好的类型自解释
 * - 正交设计，各层独立可替换
 */

// ============================================================
// 1. 消息系统 — 统一的通信协议
// ============================================================

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** 消息来源元数据 */
export interface MessageSource {
  /** 来源渠道：feishu, telegram, cli, api, ... */
  channel: string;
  /** 发送者标识 */
  senderId?: string;
  /** 发送者显示名 */
  senderName?: string;
  /** 原始消息ID（用于回复/引用） */
  messageId?: string;
  /** 会话标识 */
  conversationId?: string;
}

/** 工具调用 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 工具调用结果 */
export interface ToolResult {
  toolCallId: string;
  name: string;
  result: unknown;
  error?: string;
  /** 执行耗时 ms */
  durationMs?: number;
}

/** 统一消息格式 */
export interface Message {
  role: MessageRole;
  content: string;
  /** 来源元数据（user 消息必有） */
  source?: MessageSource;
  /** 工具调用（assistant 消息可有） */
  toolCalls?: ToolCall[];
  /** 工具结果（tool 消息必有） */
  toolResults?: ToolResult[];
  /** 时间戳 */
  timestamp: number;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

// ============================================================
// 2. Agent 定义
// ============================================================

/** Agent 人设 */
export interface AgentPersona {
  name: string;
  description: string;
  systemPrompt: string;
  /** 角色标签 */
  tags?: string[];
}

/** Agent 配置 */
export interface AgentConfig {
  persona: AgentPersona;
  /** 默认 LLM provider */
  provider: string;
  /** 默认模型 */
  model: string;
  /** 温度 */
  temperature?: number;
  /** 最大 token */
  maxTokens?: number;
  /** 可用工具列表（名称数组，运行时解析） */
  tools?: string[];
  /** 记忆配置 */
  memory?: MemoryConfig;
}

// ============================================================
// 3. Session 与 Turn
// ============================================================

/** 一次 LLM 调用 */
export interface Turn {
  id: string;
  /** 输入消息 */
  input: Message[];
  /** LLM 输出 */
  output: Message;
  /** 使用的 token */
  usage?: TokenUsage;
  /** 耗时 */
  durationMs: number;
  /** 模型标识 */
  model: string;
  /** 时间戳 */
  timestamp: number;
}

/** Token 使用量 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Session 状态 */
export type SessionStatus = 'idle' | 'thinking' | 'executing' | 'waiting_human' | 'error';

/** 一个完整的 Agent 会话 */
export interface Session {
  id: string;
  agentId: string;
  status: SessionStatus;
  turns: Turn[];
  /** 会话级记忆上下文 */
  context: ContextWindow;
  createdAt: number;
  updatedAt: number;
}

/** 上下文窗口 */
export interface ContextWindow {
  /** 系统 prompt */
  systemPrompt: string;
  /** 对话历史 */
  messages: Message[];
  /** 记忆注入（RAG、长期记忆等） */
  memoryContext?: string;
  /** 当前 token 估算 */
  estimatedTokens: number;
  /** token 上限 */
  maxTokens: number;
}

// ============================================================
// 4. 工具系统
// ============================================================

/** 工具参数定义 */
export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  enum?: string[];
  properties?: Record<string, ToolParameter>;
  items?: ToolParameter;
  default?: unknown;
}

/** 工具定义（声明式） */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  /** 权限标签 */
  permissions?: string[];
  /** 是否需要人工确认 */
  requiresConfirmation?: boolean;
  /** 超时 ms */
  timeoutMs?: number;
}

/** 工具执行上下文 */
export interface ToolExecutionContext {
  sessionId: string;
  agentId: string;
  /** 当前对话 */
  messages: Message[];
  /** 取消信号 */
  abortSignal?: AbortSignal;
}

/** 工具执行器 */
export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<unknown>;

/** 注册的工具 */
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// ============================================================
// 5. 记忆系统
// ============================================================

/** 记忆配置 */
export interface MemoryConfig {
  /** 短期：对话历史保留条数 */
  shortTermLimit?: number;
  /** 中期：session 记忆 */
  enableEpisodic?: boolean;
  /** 长期：RAG 向量检索 */
  enableSemantic?: boolean;
  /** 向量存储配置 */
  vectorStore?: VectorStoreConfig;
}

/** 向量存储配置 */
export interface VectorStoreConfig {
  provider: 'local' | 'pinecone' | 'qdrant' | 'chroma';
  connectionString?: string;
  collection?: string;
}

/** 记忆查询 */
export interface MemoryQuery {
  text: string;
  /** 返回条数 */
  limit?: number;
  /** 最低相似度 */
  minScore?: number;
  /** 过滤标签 */
  tags?: string[];
}

/** 记忆条目 */
export interface MemoryEntry {
  id: string;
  content: string;
  embedding?: number[];
  score?: number;
  source: string;
  timestamp: number;
  tags?: string[];
}

// ============================================================
// 6. LLM Provider
// ============================================================

/** LLM 请求 */
export interface LLMRequest {
  model: string;
  messages: Array<{ role: string; content: string; tool_calls?: unknown[] }>;
  tools?: unknown[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

/** LLM 响应 */
export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  model: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

/** LLM Provider 接口 */
export interface LLMProvider {
  name: string;
  /** 支持的模型列表 */
  models: string[];
  /** 发送请求 */
  complete(request: LLMRequest): Promise<LLMResponse>;
  /** 流式请求（可选） */
  stream?(request: LLMRequest): AsyncIterable<LLMResponse>;
  /** 健康检查 */
  healthCheck?(): Promise<boolean>;
}

// ============================================================
// 7. 编排
// ============================================================

/** Agent 循环事件 */
export type AgentEvent =
  | { type: 'turn_start'; turnId: string }
  | { type: 'llm_request'; request: LLMRequest }
  | { type: 'llm_response'; response: LLMResponse }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'turn_end'; turn: Turn }
  | { type: 'error'; error: Error }
  | { type: 'waiting_human'; message: string }
  | { type: 'session_end' };

/** 事件监听器 */
export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

/** Agent Harness 核心接口 */
export interface AgentHarness {
  /** 注册工具 */
  registerTool(tool: RegisteredTool): void;
  /** 注册 LLM provider */
  registerProvider(provider: LLMProvider): void;
  /** 创建 session */
  createSession(config: AgentConfig): Promise<Session>;
  /** 发送消息并获取响应 */
  send(sessionId: string, message: Message): Promise<Message>;
  /** 流式发送 */
  sendStream?(sessionId: string, message: Message): AsyncIterable<AgentEvent>;
  /** 获取 session */
  getSession(sessionId: string): Session | undefined;
  /** 结束 session */
  endSession(sessionId: string): Promise<void>;
  /** 监听事件 */
  on(listener: AgentEventListener): void;
  /** 关闭 harness */
  close(): Promise<void>;
}
