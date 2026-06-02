/**
 * Octopi 核心类型定义
 *
 * 这是整个框架的类型基础。所有模块之间的契约都通过这些接口定义。
 *
 * 设计原则（参考 OpenClaw）：
 * 1. Agent 不是一个 class，而是一个完整的 scope（workspace/session/tools/model/persona）
 * 2. Session 是一等公民，有完整的生命周期管理
 * 3. Context Engine 有 4 阶段生命周期（Ingest → Assemble → Compact → AfterTurn）
 * 4. Plugin Hooks 覆盖全链路，某些 hook 有"拦截语义"
 * 5. Channel Adapter 是消息渠道的抽象，支持多渠道接入
 */

// ============================================================
// 1. 消息系统
// ============================================================

/**
 * 消息角色
 * - user: 用户发送的消息
 * - assistant: Agent 的回复
 * - system: 系统消息（prompt injection、context 等）
 * - tool: 工具执行结果
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * 消息来源信息
 * 用于追踪消息来自哪个渠道、哪个用户
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
 *
 * 这是框架内部统一使用的消息格式。Channel Adapter 负责将
 * 外部消息（飞书、Telegram 等）转换为此格式。
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
// 2. Agent 定义 — 一个完整的独立 scope
// ============================================================

/**
 * Agent 人设
 * 定义 Agent 的身份和行为风格
 */
export interface AgentPersona {
  /** 名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 系统提示词 */
  systemPrompt: string;
  /** 标签（用于分类和搜索） */
  tags?: string[];
}

/**
 * 模型配置
 * 指定 Agent 使用哪个 LLM provider 和模型
 */
export interface ModelConfig {
  /** Provider 名称（如 openai、anthropic、mock） */
  provider: string;
  /** 模型名称（如 gpt-4o、claude-sonnet-4-20250514） */
  model: string;
  /** 温度参数（0-2） */
  temperature?: number;
  /** 最大输出 token 数 */
  maxTokens?: number;
  /** fallback 模型列表（主模型不可用时依次尝试） */
  fallbackModels?: string[];
}

/**
 * 工具策略
 * 控制 Agent 可以使用哪些工具
 */
export interface ToolPolicy {
  /** 允许的工具列表（['*'] 表示全部允许） */
  allow: string[];
  /** 拒绝的工具列表（优先级高于 allow） */
  deny?: string[];
  /** 需要人工确认的工具列表 */
  requireConfirmation?: string[];
}

/**
 * Agent 定义
 *
 * 这是框架的核心配置单元。每个 Agent 拥有：
 * - 独立的工作区（文件系统隔离）
 * - 独立的 session 存储
 * - 独立的工具集
 * - 独立的模型配置
 * - 独立的上下文引擎
 */
export interface AgentDefinition {
  /** 唯一标识符 */
  id: string;
  /** 工作区目录路径 */
  workspace: string;
  /** 人设配置 */
  persona: AgentPersona;
  /** 工具策略 */
  tools: ToolPolicy;
  /** 模型配置 */
  model: ModelConfig;
  /** 上下文引擎 ID（不设置则使用 legacy） */
  contextEngine?: string;
  /** 渠道绑定（如 { "feishu": "user:open_id_xxx" }） */
  channelBindings?: Record<string, string>;
}

// ============================================================
// 3. Session — 对话的完整生命周期
// ============================================================

/**
 * Session 状态
 * - idle: 空闲，等待用户消息
 * - processing: 正在处理（Agent Loop 运行中）
 * - waiting_human: 等待人工输入（如确认工具调用）
 * - error: 出错
 */
export type SessionStatus = 'idle' | 'processing' | 'waiting_human' | 'error';

/**
 * Session 元数据
 *
 * Session 是对话的完整上下文。一个 Session 对应：
 * - 一个 Agent
 * - 一个渠道（channel）
 * - 一个对等方（peer，可能是用户或群组）
 * - 一组消息和 turn 记录
 */
export interface SessionMeta {
  /** Session 唯一 ID */
  id: string;
  /** 所属 Agent ID */
  agentId: string;
  /** 渠道 ID */
  channelId: string;
  /** 对等方标识（由 dmScope 决定格式） */
  peerId: string;
  /** 当前状态 */
  status: SessionStatus;
  /** 创建时间 */
  createdAt: number;
  /** 当前 session 开始时间（用于 daily reset 判断） */
  sessionStartedAt: number;
  /** 最后一次用户交互时间（用于 idle reset 判断） */
  lastInteractionAt: number;
  /** 最后更新时间 */
  updatedAt: number;
}

// ============================================================
// 4. Turn — 一次完整的 Agent 调用
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
 *
 * 一个 Turn 包含：
 * - 输入消息（完整上下文）
 * - 输出消息（Agent 回复）
 * - Token 使用量
 * - 执行耗时
 * - 使用的模型
 */
export interface Turn {
  /** Turn 唯一 ID */
  id: string;
  /** 输入消息列表 */
  input: Message[];
  /** 输出消息 */
  output: Message;
  /** Token 使用量 */
  usage?: TokenUsage;
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** 使用的模型 */
  model: string;
  /** 时间戳 */
  timestamp: number;
}

// ============================================================
// 5. Context Engine — 上下文组装 4 阶段生命周期
// ============================================================

/**
 * Assemble 结果
 * 包含发送给 LLM 的消息列表和 token 估算
 */
export interface AssembleResult {
  /** 发送给 LLM 的消息列表（OpenAI API 兼容格式） */
  messages: Array<Record<string, unknown>>;
  /** 估算的 token 数 */
  estimatedTokens: number;
  /** 系统提示词追加内容（由 plugin 注入） */
  systemPromptAddition?: string;
}

/**
 * Compact 结果
 */
export interface CompactResult {
  /** 是否成功 */
  ok: boolean;
  /** 是否实际执行了压缩 */
  compacted: boolean;
  /** 压缩后的 session ID（如果创建了新 session） */
  sessionId?: string;
  /** 压缩后的 session 文件路径 */
  sessionFile?: string;
}

/**
 * Context Engine 信息
 */
export interface ContextEngineInfo {
  /** 引擎 ID */
  id: string;
  /** 引擎名称 */
  name: string;
  /** 是否自己管理压缩（true = compact 由引擎处理，false = 委托给运行时） */
  ownsCompaction: boolean;
}

/**
 * Context Engine 接口
 *
 * 上下文引擎负责管理 Agent 的对话上下文。它有 4 个生命周期阶段：
 *
 * 1. ingest — 新消息到达时调用
 *    - 记录消息、更新索引、触发异步处理
 *
 * 2. assemble — 模型调用前组装上下文
 *    - 根据 token budget 裁剪消息
 *    - 注入系统提示词、工具定义
 *    - 返回 LLM 可理解的消息格式
 *
 * 3. compact — 上下文满了或手动触发压缩
 *    - 总结历史消息
 *    - 创建新 session 或清理旧消息
 *
 * 4. afterTurn — 一轮完成后
 *    - 更新索引、触发后台任务
 */
export interface ContextEngine {
  /** 引擎信息 */
  info: ContextEngineInfo;

  /** 阶段 1：新消息到达 */
  ingest(params: { sessionId: string; message: Message }): Promise<void>;

  /** 阶段 2：组装上下文 */
  assemble(params: {
    sessionId: string;
    messages: Message[];
    tokenBudget: number;
    availableTools: string[];
  }): Promise<AssembleResult>;

  /** 阶段 3：压缩上下文 */
  compact(params: { sessionId: string; force: boolean }): Promise<CompactResult>;

  /** 阶段 4：一轮完成 */
  afterTurn(params: { sessionId: string; turn: Turn }): Promise<void>;
}

// ============================================================
// 6. 工具系统
// ============================================================

/**
 * 工具参数定义
 */
export interface ToolParameter {
  /** 参数类型 */
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  /** 参数描述 */
  description: string;
  /** 是否必填 */
  required?: boolean;
  /** 枚举值 */
  enum?: string[];
  /** 对象类型的子属性 */
  properties?: Record<string, ToolParameter>;
  /** 数组类型的元素定义 */
  items?: ToolParameter;
  /** 默认值 */
  default?: unknown;
}

/**
 * 工具定义
 */
export interface ToolDefinition {
  /** 工具名称（唯一标识） */
  name: string;
  /** 工具描述（LLM 会看到这个） */
  description: string;
  /** 参数定义 */
  parameters: Record<string, ToolParameter>;
  /** 所需权限 */
  permissions?: string[];
  /** 是否需要人工确认 */
  requiresConfirmation?: boolean;
  /** 超时时间（毫秒） */
  timeoutMs?: number;
}

/**
 * 工具执行上下文
 * 传递给工具 handler，包含 session 和 agent 信息
 */
export interface ToolExecutionContext {
  /** 当前 session ID */
  sessionId: string;
  /** 当前 agent ID */
  agentId: string;
  /** 当前消息列表 */
  messages: Message[];
  /** 中止信号（用于取消长时间运行的工具） */
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
  /** 工具定义 */
  definition: ToolDefinition;
  /** 工具处理函数 */
  handler: ToolHandler;
}

// ============================================================
// 7. 记忆系统
// ============================================================

/**
 * 记忆查询参数
 */
export interface MemoryQuery {
  /** 查询文本 */
  text: string;
  /** 返回结果数量 */
  limit?: number;
  /** 最小相关性分数 */
  minScore?: number;
  /** 标签过滤 */
  tags?: string[];
}

/**
 * 记忆条目
 */
export interface MemoryEntry {
  /** 唯一 ID */
  id: string;
  /** 内容 */
  content: string;
  /** 向量嵌入（可选） */
  embedding?: number[];
  /** 相关性分数（查询时返回） */
  score?: number;
  /** 来源标识 */
  source: string;
  /** 时间戳 */
  timestamp: number;
  /** 标签 */
  tags?: string[];
}

// ============================================================
// 8. LLM Provider
// ============================================================

/**
 * LLM 请求
 */
export interface LLMRequest {
  /** 模型名称 */
  model: string;
  /** 消息列表（OpenAI API 兼容格式） */
  messages: Array<Record<string, unknown>>;
  /** 工具定义（function calling 格式） */
  tools?: unknown[];
  /** 温度参数 */
  temperature?: number;
  /** 最大输出 token 数 */
  maxTokens?: number;
  /** 是否流式输出 */
  stream?: boolean;
}

/**
 * LLM 响应
 */
export interface LLMResponse {
  /** 回复内容 */
  content: string;
  /** 工具调用请求 */
  toolCalls?: ToolCall[];
  /** Token 使用量 */
  usage?: TokenUsage;
  /** 实际使用的模型 */
  model: string;
  /** 结束原因 */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

/**
 * LLM Provider 接口
 *
 * 每个 Provider 负责与一个 LLM 服务通信。
 * 框架通过 LLMRouter 路由请求到正确的 Provider。
 */
export interface LLMProvider {
  /** Provider 名称 */
  name: string;
  /** 支持的模型列表 */
  models: string[];
  /** 同步调用 */
  complete(request: LLMRequest): Promise<LLMResponse>;
  /** 流式调用（可选） */
  stream?(request: LLMRequest): AsyncIterable<LLMResponse>;
  /** 健康检查（可选） */
  healthCheck?(): Promise<boolean>;
}

// ============================================================
// 9. Channel Adapter — 消息渠道抽象
// ============================================================

/**
 * 渠道消息
 * 从外部渠道（飞书、Telegram、HTTP 等）接收到的消息
 */
export interface ChannelMessage {
  /** 消息 ID */
  id: string;
  /** 渠道名称 */
  channel: string;
  /** 发送者 ID */
  senderId: string;
  /** 发送者显示名 */
  senderName?: string;
  /** 消息内容 */
  content: string;
  /** 会话 ID（渠道侧） */
  conversationId: string;
  /** 时间戳 */
  timestamp: number;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 渠道回复
 * 发送到外部渠道的回复消息
 */
export interface ChannelReply {
  /** 目标渠道 */
  channel: string;
  /** 目标会话 ID */
  conversationId: string;
  /** 回复内容 */
  content: string;
  /** 回复的消息 ID（引用） */
  replyToId?: string;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * Channel Adapter 接口
 *
 * 每个 Adapter 负责与一个外部消息渠道通信。
 * 它将外部消息格式转换为框架统一的 ChannelMessage，
 * 并将框架的 ChannelReply 转换为外部格式发送。
 */
export interface ChannelAdapter {
  /** 适配器名称 */
  name: string;
  /** 启动适配器（开始监听消息） */
  start(handler: (msg: ChannelMessage) => Promise<void>): Promise<void>;
  /** 发送回复到渠道 */
  send(reply: ChannelReply): Promise<void>;
  /** 停止适配器 */
  stop(): Promise<void>;
}

// ============================================================
// 10. Command Queue — 消息队列模式
// ============================================================

/**
 * 队列模式
 *
 * - steer: 插入当前处理的下一个位置（OpenClaw 默认）
 * - followup: 排队等待当前处理完成
 * - collect: 等待更多消息后批量处理
 * - interrupt: 取消当前处理，立即处理新消息
 */
export type QueueMode = 'steer' | 'followup' | 'collect' | 'interrupt';

/**
 * 队列参数
 */
export interface QueueParams {
  /** 消息 */
  message: ChannelMessage;
  /** 队列模式 */
  mode?: QueueMode;
}

// ============================================================
// 11. Plugin Hooks
// ============================================================

/**
 * Hook 上下文
 * 传递给 plugin hook 的基础上下文信息
 */
export interface HookContext {
  /** 当前 session ID */
  sessionId: string;
  /** 当前 agent ID */
  agentId: string;
  /** 扩展属性 */
  [key: string]: unknown;
}

/**
 * Plugin Hooks 定义
 *
 * 每个 hook 对应 Agent Loop 的一个生命周期阶段。
 * 带 "拦截语义" 的 hook 返回非 null 时会改变执行流程。
 *
 * Hook 执行顺序：按 plugin 注册顺序
 */
export interface PluginHooks {
  /**
   * 模型解析前
   * 拦截语义：返回 { provider, model } 可覆盖模型选择
   */
  before_model_resolve?(
    ctx: HookContext,
  ): Promise<{ provider?: string; model?: string } | null>;

  /**
   * Prompt 构建前
   * 拦截语义：返回 { prependContext, systemPromptAddition } 可注入上下文
   */
  before_prompt_build?(
    ctx: HookContext & { messages: Message[] },
  ): Promise<{
    prependContext?: string;
    systemPromptAddition?: string;
  } | null>;

  /**
   * Agent 回复前
   * 拦截语义：返回 Message 可替代 LLM 的回复
   * 典型用途：缓存命中、规则引擎、人工接管
   */
  before_agent_reply?(
    ctx: HookContext & { messages: Message[] },
  ): Promise<Message | null>;

  /**
   * 工具调用前
   * 拦截语义：返回 { block: true } 可阻止工具执行
   * 典型用途：权限检查、安全审计
   */
  before_tool_call?(
    ctx: HookContext & { call: ToolCall },
  ): Promise<{ block: boolean } | null>;

  /**
   * 工具调用后
   * 无拦截语义：所有 plugin 都会执行
   * 典型用途：日志记录、指标收集
   */
  after_tool_call?(
    ctx: HookContext & { call: ToolCall; result: ToolResult },
  ): Promise<void>;

  /**
   * 消息到达时
   * 无拦截语义
   * 典型用途：消息预处理、过滤、审计
   */
  message_received?(
    ctx: HookContext & { message: ChannelMessage },
  ): Promise<void>;

  /**
   * 消息发送前
   * 拦截语义：返回 { cancel: true } 可阻止消息发送
   * 典型用途：内容过滤、格式转换
   */
  message_sending?(
    ctx: HookContext & { reply: ChannelReply },
  ): Promise<{ cancel: boolean } | null>;

  /**
   * 消息发送后
   * 无拦截语义
   * 典型用途：发送确认、日志记录
   */
  message_sent?(
    ctx: HookContext & { reply: ChannelReply },
  ): Promise<void>;

  /**
   * Session 开始
   * 无拦截语义
   */
  session_start?(ctx: HookContext): Promise<void>;

  /**
   * Session 结束
   * 无拦截语义
   */
  session_end?(ctx: HookContext): Promise<void>;
}

/**
 * Plugin 定义
 */
export interface Plugin {
  /** 唯一 ID */
  id: string;
  /** 名称 */
  name: string;
  /** Hook 实现 */
  hooks: PluginHooks;
}

// ============================================================
// 12. Agent Event — 全链路可观测
// ============================================================

/**
 * Agent 事件
 *
 * 覆盖 Agent Loop 的所有关键节点，用于：
 * - 日志记录
 * - 指标收集
 * - 调试追踪
 * - 实时监控
 */
export type AgentEvent =
  /** Turn 开始 */
  | { type: 'turn_start'; turnId: string; sessionId: string }
  /** LLM 请求发出 */
  | { type: 'llm_request'; request: LLMRequest }
  /** LLM 响应收到 */
  | { type: 'llm_response'; response: LLMResponse }
  /** 工具调用开始 */
  | { type: 'tool_call'; call: ToolCall }
  /** 工具调用完成 */
  | { type: 'tool_result'; result: ToolResult }
  /** Turn 结束 */
  | { type: 'turn_end'; turn: Turn }
  /** 错误 */
  | { type: 'error'; error: Error }
  /** 等待人工输入 */
  | { type: 'waiting_human'; message: string }
  /** Session 结束 */
  | { type: 'session_end'; sessionId: string }
  /** 上下文压缩 */
  | { type: 'compaction'; sessionId: string };

/**
 * 事件监听器
 */
export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

// ============================================================
// 13. Gateway 配置
// ============================================================

/**
 * Gateway 配置
 *
 * Gateway 是框架的入口点，负责：
 * - 管理所有 Agent
 * - 管理所有 Channel Adapter
 * - 路由消息到正确的 Agent
 * - 维护 Session 状态
 */
export interface GatewayConfig {
  /** 监听端口（HTTP adapter 用） */
  port?: number;
  /** Agent 列表 */
  agents: AgentDefinition[];
  /** Session 配置 */
  session?: {
    /**
     * DM 作用域
     * - main: 所有消息共享一个 session
     * - per-peer: 每个发送者一个 session
     * - per-channel-peer: 每个渠道+发送者一个 session
     */
    dmScope?: 'main' | 'per-peer' | 'per-channel-peer';
    /** Session 重置配置 */
    reset?: {
      /** 每日重置时间（小时，0-23） */
      dailyHour?: number;
      /** 空闲重置时间（分钟） */
      idleMinutes?: number;
    };
    /** 维护配置 */
    maintenance?: {
      /** 模式：warn=仅警告，enforce=强制执行 */
      mode?: 'warn' | 'enforce';
      /** 多久后清理（如 '30d'） */
      pruneAfter?: string;
      /** 最大消息数 */
      maxEntries?: number;
    };
  };
}
