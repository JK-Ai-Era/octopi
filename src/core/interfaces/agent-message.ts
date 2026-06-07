/**
 * Agent 通信协议 — Core 层接口
 *
 * 定义 Agent 间通信的消息格式和通信接口。
 * 基于 EventBus 构建，提供高层通信抽象。
 *
 * 设计原则：
 * - AgentMessage 是一种特殊的 AgentEvent
 * - 基于 EventBus 的发布/订阅机制
 * - 支持多种通信模式：直接、请求-响应、广播、委托
 */

// ── 消息类型 ──

/** Agent 消息类型 */
export type AgentMessageType =
  | 'request'      // 请求（任务分配）
  | 'response'     // 响应（任务结果）
  | 'query'        // 查询（请求信息）
  | 'reply'        // 回复（提供信息）
  | 'broadcast'    // 广播（通知所有）
  | 'delegate'     // 委托（转交任务）
  | 'escalate';    // 上报（交给上级）

// ── 消息定义 ──

/** Agent 消息 */
export interface AgentMessage {
  /** 消息 ID */
  id: string;
  /** 消息类型 */
  type: AgentMessageType;
  /** 发送者 Agent ID */
  from: string;
  /** 接收者（支持多播，'*' 表示广播） */
  to: string | string[];
  /** 会话 ID（用于关联相关消息） */
  conversationId: string;
  /** 回复的消息 ID */
  replyTo?: string;
  /** 时间戳 */
  timestamp: number;
  /** 消息内容 */
  content: string;
  /** 结构化数据（可选） */
  structured?: unknown;
  /** 元数据 */
  metadata: AgentMessageMetadata;
}

/** 消息元数据 */
export interface AgentMessageMetadata {
  /** 优先级 */
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** 消息过期时间（毫秒） */
  ttl?: number;
  /** 需要的能力标签 */
  capabilities?: string[];
  /** 标签 */
  tags?: string[];
  /** 扩展数据 */
  extra?: Record<string, unknown>;
}

// ── 通信接口 ──

/**
 * Agent 通信接口
 *
 * 提供 Agent 间通信的抽象，支持多种通信模式。
 */
export interface AgentCommunicator {
  /**
   * 发送消息
   *
   * @param message - 要发送的消息
   */
  send(message: AgentMessage): Promise<void>;

  /**
   * 接收消息（异步迭代器）
   *
   * @param agentId - 接收者 Agent ID
   * @yields 接收到的消息
   */
  receive(agentId: string): AsyncGenerator<AgentMessage>;

  /**
   * 广播消息
   *
   * @param message - 要广播的消息（不需要 to 字段）
   */
  broadcast(message: Omit<AgentMessage, 'to'>): Promise<void>;

  /**
   * 请求-响应模式
   *
   * @param message - 请求消息
   * @param timeout - 超时时间（毫秒）
   * @returns 响应消息
   */
  request(message: AgentMessage, timeout?: number): Promise<AgentMessage>;

  /**
   * 注册消息处理器
   *
   * @param agentId - Agent ID
   * @param handler - 消息处理函数（同步或异步）
   */
  onMessage(agentId: string, handler: (message: AgentMessage) => void | Promise<void>): void;
}

// ── 事件类型 ──

/** Agent 消息事件（用于 EventBus） */
export const AgentMessageEvents = {
  /** 消息发送 */
  MESSAGE_SENT: 'agent.message.sent',
  /** 消息接收 */
  MESSAGE_RECEIVED: 'agent.message.received',
  /** 消息过期 */
  MESSAGE_EXPIRED: 'agent.message.expired',
  /** 请求超时 */
  REQUEST_TIMEOUT: 'agent.request.timeout',
} as const;
