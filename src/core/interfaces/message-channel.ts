/**
 * MessageChannel — 进程间通信协议
 *
 * 职责：定义 Agent 进程之间如何通信。
 * 实现方：内存队列、Unix Socket、WebSocket、消息队列等。
 *
 * 设计要点：
 * - 点对点消息传递（有明确的接收方）
 * - 支持同步等待回复（request-reply 模式）
 * - 支持 fire-and-forget（单向通知）
 * - 消息有序、不丢失（由实现方保证）
 */

// ── 消息格式 ──

/** 进程间消息 */
export interface ProcessMessage {
  /** 消息唯一 ID */
  id: string;
  /** 发送方进程 ID */
  from: string;
  /** 接收方进程 ID */
  to: string;
  /** 消息类型（用于路由和处理） */
  type: string;
  /** 消息载荷 */
  payload: unknown;
  /** 消息时间戳 */
  timestamp: number;
  /** 关联消息 ID（用于 request-reply 关联） */
  replyTo?: string;
  /** 消息 TTL（毫秒，过期后丢弃） */
  ttlMs?: number;
}

/** 消息处理器 */
export type MessageHandler = (message: ProcessMessage) => void | Promise<void>;

// ── 接口定义 ──

/**
 * MessageChannel 接口
 *
 * 提供进程间消息传递能力。
 * Core 层的 ProcessModel 使用此接口实现进程间通信。
 */
export interface MessageChannel {
  /**
   * 发送消息（fire-and-forget）
   *
   * @param message - 要发送的消息
   */
  send(message: Omit<ProcessMessage, 'id' | 'timestamp'>): Promise<void>;

  /**
   * 发送消息并等待回复（request-reply）
   *
   * @param message - 要发送的消息
   * @param timeoutMs - 等待超时（毫秒）
   * @returns 回复消息
   * @throws 超时时抛出错误
   */
  request(message: Omit<ProcessMessage, 'id' | 'timestamp'>, timeoutMs: number): Promise<ProcessMessage>;

  /**
   * 注册消息处理器
   *
   * @param type - 消息类型（'*' 匹配所有类型）
   * @param handler - 消息处理器
   * @returns Disposable，调用 dispose 取消注册
   */
  on(type: string, handler: MessageHandler): { dispose(): void };
}
