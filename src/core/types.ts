/**
 * Agent Harness 核心类型定义
 *
 * 参考 OpenClaw 架构，定义完整的消息、Session、Agent、工具、记忆、Plugin 等接口。
 */

// ============================================================
// 1. 消息系统
// ============================================================

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface MessageSource {
  channel: string;
  senderId?: string;
  senderName?: string;
  messageId?: string;
  conversationId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  result: unknown;
  error?: string;
  durationMs?: number;
}

export interface Message {
  role: MessageRole;
  content: string;
  source?: MessageSource;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ============================================================
// 2. Agent 定义 — 一个完整的独立 scope
// ============================================================

export interface AgentPersona {
  name: string;
  description: string;
  systemPrompt: string;
  tags?: string[];
}

export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  fallbackModels?: string[];
}

export interface ToolPolicy {
  /** 允许的工具列表（* 表示全部允许） */
  allow: string[];
  /** 拒绝的工具列表 */
  deny?: string[];
  /** 需要人工确认的工具 */
  requireConfirmation?: string[];
}

export interface AgentDefinition {
  id: string;
  /** Agent 的工作区目录 */
  workspace: string;
  persona: AgentPersona;
  tools: ToolPolicy;
  model: ModelConfig;
  /** 自定义上下文引擎 id（不设置则用 legacy） */
  contextEngine?: string;
}

// ============================================================
// 3. Session — 对话的完整生命周期
// ============================================================

export type SessionStatus = 'idle' | 'processing' | 'waiting_human' | 'error';

export interface SessionMeta {
  id: string;
  agentId: string;
  channelId: string;
  peerId: string;
  status: SessionStatus;
  createdAt: number;
  /** 当前 session 开始时间（daily reset 用） */
  sessionStartedAt: number;
  /** 最后一次用户交互（idle reset 用） */
  lastInteractionAt: number;
  updatedAt: number;
}

// ============================================================
// 4. Turn — 一次完整的 Agent 调用
// ============================================================

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

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
// 5. Context Engine — 上下文组装 4 阶段生命周期
// ============================================================

export interface AssembleResult {
  messages: Array<{ role: string; content: string; tool_calls?: unknown[] }>;
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

  /** 1. 新消息到达时调用 */
  ingest(params: { sessionId: string; message: Message }): Promise<void>;

  /** 2. 模型调用前组装上下文 */
  assemble(params: {
    sessionId: string;
    messages: Message[];
    tokenBudget: number;
    availableTools: string[];
  }): Promise<AssembleResult>;

  /** 3. 上下文满了或手动触发压缩 */
  compact(params: {
    sessionId: string;
    force: boolean;
  }): Promise<CompactResult>;

  /** 4. 一轮完成后 */
  afterTurn(params: {
    sessionId: string;
    turn: Turn;
  }): Promise<void>;
}

// ============================================================
// 6. 工具系统
// ============================================================

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  enum?: string[];
  properties?: Record<string, ToolParameter>;
  items?: ToolParameter;
  default?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  permissions?: string[];
  requiresConfirmation?: boolean;
  timeoutMs?: number;
}

export interface ToolExecutionContext {
  sessionId: string;
  agentId: string;
  messages: Message[];
  abortSignal?: AbortSignal;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<unknown>;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// ============================================================
// 7. 记忆系统
// ============================================================

export interface MemoryQuery {
  text: string;
  limit?: number;
  minScore?: number;
  tags?: string[];
}

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
// 8. LLM Provider
// ============================================================

export interface LLMRequest {
  model: string;
  messages: Array<{ role: string; content: string; tool_calls?: unknown[] }>;
  tools?: unknown[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  model: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

export interface LLMProvider {
  name: string;
  models: string[];
  complete(request: LLMRequest): Promise<LLMResponse>;
  stream?(request: LLMRequest): AsyncIterable<LLMResponse>;
  healthCheck?(): Promise<boolean>;
}

// ============================================================
// 9. Channel Adapter — 消息渠道抽象
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
  /** 启动适配器（监听消息） */
  start(handler: (msg: ChannelMessage) => Promise<void>): Promise<void>;
  /** 发送回复 */
  send(reply: ChannelReply): Promise<void>;
  /** 停止 */
  stop(): Promise<void>;
}

// ============================================================
// 10. Command Queue
// ============================================================

export type QueueMode = 'steer' | 'followup' | 'collect' | 'interrupt';

export interface QueueParams {
  message: ChannelMessage;
  mode?: QueueMode;
}

// ============================================================
// 11. Plugin Hooks
// ============================================================

export interface HookContext {
  sessionId: string;
  agentId: string;
  [key: string]: unknown;
}

export interface PluginHooks {
  /** 模型解析前：可以覆盖 provider/model */
  before_model_resolve?(ctx: HookContext): Promise<{ provider?: string; model?: string } | null>;

  /** Prompt 构建前：可以注入上下文 */
  before_prompt_build?(ctx: HookContext & { messages: Message[] }): Promise<{
    prependContext?: string;
    systemPromptAddition?: string;
  } | null>;

  /** Agent 回复前：可以拦截并返回合成回复 */
  before_agent_reply?(ctx: HookContext & { messages: Message[] }): Promise<Message | null>;

  /** 工具调用前：可以拦截 */
  before_tool_call?(ctx: HookContext & { call: ToolCall }): Promise<{ block: boolean } | null>;

  /** 工具调用后 */
  after_tool_call?(ctx: HookContext & { call: ToolCall; result: ToolResult }): Promise<void>;

  /** 消息到达时 */
  message_received?(ctx: HookContext & { message: ChannelMessage }): Promise<void>;

  /** 消息发送前：可以取消 */
  message_sending?(ctx: HookContext & { reply: ChannelReply }): Promise<{ cancel: boolean } | null>;

  /** 消息发送后 */
  message_sent?(ctx: HookContext & { reply: ChannelReply }): Promise<void>;

  /** Session 开始 */
  session_start?(ctx: HookContext): Promise<void>;

  /** Session 结束 */
  session_end?(ctx: HookContext): Promise<void>;
}

export interface Plugin {
  id: string;
  name: string;
  hooks: PluginHooks;
}

// ============================================================
// 12. Agent Event — 全链路可观测
// ============================================================

export type AgentEvent =
  | { type: 'turn_start'; turnId: string; sessionId: string }
  | { type: 'llm_request'; request: LLMRequest }
  | { type: 'llm_response'; response: LLMResponse }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'turn_end'; turn: Turn }
  | { type: 'error'; error: Error }
  | { type: 'waiting_human'; message: string }
  | { type: 'session_end'; sessionId: string }
  | { type: 'compaction'; sessionId: string };

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

// ============================================================
// 13. Gateway 接口
// ============================================================

export interface GatewayConfig {
  /** Gateway 监听端口 */
  port?: number;
  /** Agent 列表 */
  agents: AgentDefinition[];
  /** Session 配置 */
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

export interface Gateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  registerAgent(agent: AgentDefinition): void;
  registerChannel(adapter: ChannelAdapter): void;
  registerPlugin(plugin: Plugin): void;
  registerTool(tool: RegisteredTool, agentId?: string): void;
  registerProvider(provider: LLMProvider): void;
  send(message: ChannelMessage): Promise<void>;
  getSession(sessionId: string): SessionMeta | undefined;
}
