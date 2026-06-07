/**
 * DefaultAgentCommunicator — 基于 EventBus 的 Agent 通信实现
 *
 * 实现 AgentCommunicator 接口，使用 EventBus 进行消息传递。
 * 支持：直接通信、请求-响应、广播、委托。
 *
 * 设计说明：
 * - EventBus.emit 接受 AgentEvent { type, timestamp, data }
 * - AgentMessage 包装在 AgentEvent.data 中
 * - 消息分发是同步的（立即调用处理器）
 */

import { randomUUID } from 'node:crypto';
import type { EventBus, AgentEvent } from './event-bus.js';
import type {
  AgentMessage,
  AgentCommunicator,
  AgentMessageMetadata,
} from './interfaces/agent-message.js';
import { AgentMessageEvents } from './interfaces/agent-message.js';

/**
 * DefaultAgentCommunicator
 *
 * 基于 EventBus 的 Agent 通信实现。
 */
export class DefaultAgentCommunicator implements AgentCommunicator {
  private events: EventBus;
  /** 注册的消息处理器（同步） */
  private handlers: Map<string, (message: AgentMessage) => void> = new Map();
  /** 待处理的请求（用于请求-响应模式） */
  private pendingRequests: Map<string, {
    resolve: (message: AgentMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();
  /** 接收队列（用于异步迭代器） */
  private receiveQueues: Map<string, {
    queue: AgentMessage[];
    resolve: (() => void) | null;
  }> = new Map();

  constructor(events: EventBus) {
    this.events = events;
    this.setupListeners();
  }

  /**
   * 设置事件监听器
   */
  private setupListeners(): void {
    // 监听 agent.message 事件
    this.events.on('agent.message', (event: AgentEvent) => {
      const message = event.data as unknown as AgentMessage;

      // 检查消息是否过期
      if (this.isExpired(message)) {
        this.emitEvent(AgentMessageEvents.MESSAGE_EXPIRED, message);
        return;
      }

      // 触发接收事件
      this.emitEvent(AgentMessageEvents.MESSAGE_RECEIVED, message);

      // 处理请求-响应匹配
      if (message.replyTo) {
        const pending = this.pendingRequests.get(message.replyTo);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(message.replyTo);
          pending.resolve(message);
          return;
        }
      }

      // 分发消息到处理器和队列
      this.dispatchMessage(message);
    });
  }

  /**
   * 发送消息
   */
  async send(message: AgentMessage): Promise<void> {
    const fullMessage: AgentMessage = {
      ...message,
      id: message.id || randomUUID(),
      timestamp: message.timestamp || Date.now(),
    };

    // 发送事件（同步）
    this.emitEvent('agent.message', fullMessage);
    this.emitEvent(AgentMessageEvents.MESSAGE_SENT, fullMessage);
  }

  /**
   * 接收消息（异步迭代器）
   */
  async *receive(agentId: string): AsyncGenerator<AgentMessage> {
    // 初始化队列
    if (!this.receiveQueues.has(agentId)) {
      this.receiveQueues.set(agentId, { queue: [], resolve: null });
    }
    const queueState = this.receiveQueues.get(agentId)!;

    try {
      while (true) {
        // 等待消息
        if (queueState.queue.length === 0) {
          await new Promise<void>((r) => {
            queueState.resolve = r;
          });
        }
        // 返回消息
        if (queueState.queue.length > 0) {
          yield queueState.queue.shift()!;
        }
      }
    } finally {
      // 清理
      this.receiveQueues.delete(agentId);
    }
  }

  /**
   * 广播消息
   */
  async broadcast(message: Omit<AgentMessage, 'to'>): Promise<void> {
    await this.send({
      ...message,
      to: '*',
    });
  }

  /**
   * 请求-响应模式
   */
  async request(message: AgentMessage, timeout: number = 30000): Promise<AgentMessage> {
    return new Promise<AgentMessage>((resolve, reject) => {
      const messageId = message.id || randomUUID();

      // 设置超时
      const timer = setTimeout(() => {
        this.pendingRequests.delete(messageId);
        this.emitEvent(AgentMessageEvents.REQUEST_TIMEOUT, { messageId } as unknown as AgentMessage);
        reject(new Error(`Request timeout after ${timeout}ms`));
      }, timeout);

      // 存储待处理请求
      this.pendingRequests.set(messageId, {
        resolve,
        reject,
        timer,
      });

      // 发送请求
      this.send({
        ...message,
        id: messageId,
      });
    });
  }

  /**
   * 注册消息处理器（同步）
   */
  onMessage(agentId: string, handler: (message: AgentMessage) => void): void {
    this.handlers.set(agentId, handler);
  }

  /**
   * 发射 AgentEvent 到 EventBus
   */
  private emitEvent(type: string, message: AgentMessage | Record<string, unknown>): void {
    this.events.emit({
      type,
      timestamp: Date.now(),
      data: message as unknown as Record<string, unknown>,
    });
  }

  /**
   * 分发消息到处理器和队列
   */
  private dispatchMessage(message: AgentMessage): void {
    const targets = Array.isArray(message.to) ? message.to : [message.to];

    for (const target of targets) {
      if (target === '*') {
        this.dispatchToAll(message);
      } else {
        this.dispatchToTarget(target, message);
      }
    }
  }

  /**
   * 广播分发
   */
  private dispatchToAll(message: AgentMessage): void {
    for (const [agentId, handler] of this.handlers) {
      this.safeDispatch(agentId, handler, message);
    }
    for (const [agentId, queueState] of this.receiveQueues) {
      if (!this.handlers.has(agentId)) {
        this.enqueueMessage(agentId, queueState, message);
      }
    }
  }

  /**
   * 定向分发
   */
  private dispatchToTarget(target: string, message: AgentMessage): void {
    const handler = this.handlers.get(target);
    if (handler) {
      this.safeDispatch(target, handler, message);
      return;
    }
    const queueState = this.receiveQueues.get(target);
    if (queueState) {
      this.enqueueMessage(target, queueState, message);
    }
  }

  /**
   * 入队消息
   */
  private enqueueMessage(
    agentId: string,
    queueState: { queue: AgentMessage[]; resolve: (() => void) | null },
    message: AgentMessage
  ): void {
    queueState.queue.push(message);
    if (queueState.resolve) {
      const resolve = queueState.resolve;
      queueState.resolve = null;
      resolve();
    }
  }

  /**
   * 安全分发（捕获错误）
   */
  private safeDispatch(
    agentId: string,
    handler: (message: AgentMessage) => void,
    message: AgentMessage
  ): void {
    try {
      handler(message);
    } catch (error) {
      console.error(`[AgentCommunicator] Error dispatching to ${agentId}:`, error);
    }
  }

  /**
   * 检查消息是否过期
   */
  private isExpired(message: AgentMessage): boolean {
    if (!message.metadata.ttl) return false;
    return Date.now() - message.timestamp > message.metadata.ttl;
  }

  /**
   * 清理资源
   */
  dispose(): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Communicator disposed'));
    }
    this.pendingRequests.clear();
    this.handlers.clear();
    this.receiveQueues.clear();
  }
}

/**
 * 创建 Agent 消息的工厂函数
 */
export function createAgentMessage(
  type: AgentMessage['type'],
  from: string,
  to: string | string[],
  content: string,
  options?: {
    conversationId?: string;
    replyTo?: string;
    structured?: unknown;
    metadata?: Partial<AgentMessageMetadata>;
  }
): AgentMessage {
  return {
    id: randomUUID(),
    type,
    from,
    to,
    conversationId: options?.conversationId ?? `conv-${randomUUID().slice(0, 8)}`,
    replyTo: options?.replyTo,
    timestamp: Date.now(),
    content,
    structured: options?.structured,
    metadata: {
      priority: 'normal',
      ...options?.metadata,
    },
  };
}
