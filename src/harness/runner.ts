/**
 * SessionAwareRunner — Session 感知的运行器
 *
 * Harness 层组件。在 AgentEngine 之上管理 Session 生命周期：
 * - 消息持久化
 * - Session 锁（同一 session 同时只有一个运行）
 * - Daily reset / Idle reset
 * - 并发控制
 *
 * AgentEngine 是无状态的循环引擎，Session 管理在这里。
 */

import type { Message, Turn, SessionStatus } from '../core/types.js';
import type { SessionStore, SessionData } from '../core/interfaces/session-store.js';
import type { AgentEngine, RunConfig } from '../core/engine.js';
import type { AgentEvent } from '../core/event-bus.js';
import { createSessionStateMachine, type StateMachine } from '../core/state-machine.js';

/**
 * 任务决策提供者接口
 *
 * Harness 层组件，在用户消息到达时调用 LLM 判断任务状态。
 * SessionAwareRunner 在调用 engine.run() 之前调用一次。
 */
export interface TaskDecisionProvider {
  decide(params: {
    sessionId: string;
    messages: Message[];
  }): Promise<TaskDecisionResult>;
}

/** 任务决策结果 */
export interface TaskDecisionResult {
  /** 注入到 systemPrompt 的任务上下文 */
  taskContext?: string;
  /** 决策理由（用于日志/可观测性） */
  reason?: string;
}

/** Session 锁队列项 */
interface QueueEntry {
  resolve: () => void;
}

/** 运行器配置 */
export interface SessionAwareRunnerConfig {
  /** Session 过期时间（毫秒，默认 24 小时） */
  sessionExpiryMs?: number;
  /** 空闲过期时间（毫秒，默认 2 小时） */
  idleExpiryMs?: number;
  /** 是否启用 daily reset */
  enableDailyReset?: boolean;
  /**
   * 任务决策提供者（可选）
   *
   * 在用户消息到达时调用 LLM 判断任务状态，
   * 将结果注入到 runConfig.injectedContext，由 ContextEngine 透传到 systemPrompt。
   *
   * 调用时机：handle() 中追加用户消息后、engine.run() 前，只调用一次。
   * 工具调用循环中不会重复调用。
   */
  taskDecisionProvider?: TaskDecisionProvider;
}

const DEFAULT_CONFIG: SessionAwareRunnerConfig = {
  sessionExpiryMs: 24 * 60 * 60 * 1000, // 24 小时
  idleExpiryMs: 2 * 60 * 60 * 1000,     // 2 小时
  enableDailyReset: true,
};

/**
 * SessionAwareRunner
 */
export class SessionAwareRunner {
  private engine: AgentEngine;
  private store: SessionStore;
  /** 锁状态：true = 已锁定，false = 空闲 */
  private locked = new Map<string, boolean>();
  /** 等待队列：每个 session 一个 FIFO 队列 */
  private queues = new Map<string, QueueEntry[]>();
  private config: SessionAwareRunnerConfig;
  /** Session 状态机缓存 */
  private stateMachines = new Map<string, StateMachine<SessionStatus>>();
  /** 分布式智能体运行时（可选） */
  private _distributedRuntime?: import('./distributed/runtime.js').AgentRuntime;
  /** EventBus 引用（用于分布式智能体上下文） */
  private _events?: import('../core/event-bus.js').EventBus;

  constructor(engine: AgentEngine, store: SessionStore, config?: SessionAwareRunnerConfig & { events?: import('../core/event-bus.js').EventBus }) {
    this.engine = engine;
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._events = config?.events;
  }

  /** 设置分布式智能体运行时 */
  setDistributedRuntime(runtime: import('./distributed/runtime.js').AgentRuntime): void {
    this._distributedRuntime = runtime;
  }

  /**
   * 处理一条消息
   *
   * @param sessionId - Session 标识
   * @param input - 用户输入消息
   * @param runConfig - Agent 运行配置
   * @param signal - 中止信号
   * @yields AgentEvent 事件流
   */
  async *handle(
    sessionId: string,
    input: Message,
    runConfig: RunConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    // 1. 获取锁
    const release = await this.acquireLock(sessionId);

    try {
      // 2. 加载或创建 session
      let session = await this.store.load(sessionId);
      if (!session) {
        session = this.createSession(sessionId, runConfig.agentId ?? 'default');
      }

      // 3. 检查 session 是否需要重置
      this.checkSessionReset(session);

      // 4. 追加用户消息
      session.messages.push(input);
      session.meta.lastInteractionAt = Date.now();
      session.meta.updatedAt = Date.now();

      // 状态机：idle → processing
      const sm = this.getOrCreateStateMachine(sessionId, session.meta.status);
      sm.transition('processing');
      session.meta.status = sm.state;

      // 5. 任务决策（如果配置了 TaskDecisionProvider）
      //    在用户消息到达时调用一次，不在工具调用循环中重复调用
      let effectiveRunConfig = runConfig;
      if (this.config.taskDecisionProvider && input.role === 'user') {
        try {
          const decision = await this.config.taskDecisionProvider.decide({
            sessionId,
            messages: session.messages,
          });
          if (decision.taskContext) {
            effectiveRunConfig = {
              ...runConfig,
              injectedContext: decision.taskContext,
            };
          }
        } catch (err) {
          // 任务决策失败不阻塞主流程
          console.warn('[SessionAwareRunner] TaskDecisionProvider failed:', err);
        }
      }

      // 6. 应用分布式智能体的待处理注入
      if (this._distributedRuntime) {
        if (this._events) {
          this._distributedRuntime.setMainAgentContext({
            messages: session.messages,
            runConfig: effectiveRunConfig,
            events: this._events,
          });
        }
        this._distributedRuntime.applyPendingInjections(session.messages);
      }

      // 7. 运行 AgentEngine
      let hasTurnEnd = false;
      let streamedContent = '';
      let lastUsage: any = undefined;

      for await (const event of this.engine.run(session.messages, effectiveRunConfig, signal)) {
        yield event;

        // 收集流式内容（用于引擎异常退出时的 fallback）
        if (event.type === 'llm_stream_delta' && event.data?.delta) {
          streamedContent += event.data.delta as string;
        }

        // 如果是 turn.end，记录 turn
        if (event.type === 'turn.end' && event.data) {
          hasTurnEnd = true;
          lastUsage = event.data.usage;
          const turn: Turn = {
            id: `turn_${Date.now()}`,
            input: session.messages.slice(0, -1),
            output: {
              role: 'assistant',
              content: event.data.content as string,
              timestamp: Date.now(),
            },
            usage: event.data.usage as any,
            durationMs: 0,
            model: runConfig.model ?? 'unknown',
            timestamp: Date.now(),
          };
          session.turns.push(turn);

          // 追加 assistant 消息到 session
          session.messages.push({
            role: 'assistant',
            content: event.data.content as string,
            timestamp: Date.now(),
          });
        }
      }

      // 6. 引擎异常退出时的 session 一致性修复
      //    如果引擎以 budget.exceeded 或 engine.error 退出，没有 yield turn.end，
      //    需要将已流式输出的内容保存到 session，避免下次加载时上下文断裂。
      if (!hasTurnEnd) {
        const fallbackContent = streamedContent || '';
        if (fallbackContent) {
          // 有流式内容但没有 turn.end → 保存为 assistant 消息
          session.messages.push({
            role: 'assistant',
            content: fallbackContent,
            timestamp: Date.now(),
          });
          session.turns.push({
            id: `turn_${Date.now()}`,
            input: session.messages.slice(0, -1),
            output: {
              role: 'assistant',
              content: fallbackContent,
              timestamp: Date.now(),
            },
            usage: lastUsage,
            durationMs: 0,
            model: runConfig.model ?? 'unknown',
            timestamp: Date.now(),
          });
        }
        // 即使没有内容，也标记 session 状态，不让它卡在 'processing'
      }

      // 7. 持久化
      sm.transition('idle');
      session.meta.status = sm.state;
      session.meta.updatedAt = Date.now();
      await this.store.save(sessionId, session);

    } catch (err) {
      // 引擎出错：状态机转到 error，持久化
      const sm = this.stateMachines.get(sessionId);
      if (sm?.canTransition('error')) {
        sm.transition('error');
        const session = await this.store.load(sessionId);
        if (session) {
          session.meta.status = sm.state;
          session.meta.updatedAt = Date.now();
          await this.store.save(sessionId, session);
        }
      }
      throw err;
    } finally {
      release();
    }
  }

  /**
   * 获取 Session 锁
   * 同一 session 同时只有一个运行
   *
   * 使用 Promise 队列实现，避免 polling 开销。
   * 请求按 FIFO 顺序获取锁，无饥饿问题。
   */
  private async acquireLock(sessionId: string): Promise<() => void> {
    // 如果已锁定，入队等待
    if (this.locked.get(sessionId)) {
      await new Promise<void>(resolve => {
        if (!this.queues.has(sessionId)) {
          this.queues.set(sessionId, []);
        }
        this.queues.get(sessionId)!.push({ resolve });
      });
    }

    // 获取锁
    this.locked.set(sessionId, true);

    let released = false;
    return () => {
      if (released) return;
      released = true;

      // 释放锁：唤醒队列中下一个等待者
      const queue = this.queues.get(sessionId);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        next.resolve();
      } else {
        // 队列为空，标记为未锁定
        this.locked.set(sessionId, false);
        // 清理空队列
        this.queues.delete(sessionId);
      }
    };
  }

  /**
   * 创建新 Session
   */
  private createSession(sessionId: string, agentId: string): SessionData {
    return {
      id: sessionId,
      agentId,
      meta: {
        id: sessionId,
        agentId,
        channelId: 'unknown',
        peerId: 'unknown',
        status: 'idle',
        createdAt: Date.now(),
        sessionStartedAt: Date.now(),
        lastInteractionAt: Date.now(),
        updatedAt: Date.now(),
      },
      messages: [],
      turns: [],
      metadata: {},
    };
  }

  /**
   * 获取或创建 Session 状态机
   *
   * 如果 session 已有状态，从该状态初始化状态机（避免重启后状态不同步）。
   */
  private getOrCreateStateMachine(sessionId: string, currentStatus?: SessionStatus): StateMachine<SessionStatus> {
    let sm = this.stateMachines.get(sessionId);
    if (!sm) {
      sm = createSessionStateMachine();
      // 从 session 当前状态初始化（处理重启/恢复场景）
      if (currentStatus && currentStatus !== 'idle') {
        sm.force(currentStatus);
      }
      this.stateMachines.set(sessionId, sm);
    }
    return sm;
  }

  /**
   * 检查 Session 是否需要重置
   */
  private checkSessionReset(session: SessionData): void {
    const now = Date.now();

    // Daily reset
    if (this.config.enableDailyReset) {
      const sessionDay = new Date(session.meta.sessionStartedAt).toDateString();
      const today = new Date(now).toDateString();
      if (sessionDay !== today) {
        session.messages = [];
        session.turns = [];
        session.meta.sessionStartedAt = now;
      }
    }

    // Idle reset
    if (this.config.idleExpiryMs) {
      const idle = now - session.meta.lastInteractionAt;
      if (idle > this.config.idleExpiryMs) {
        session.messages = [];
        session.turns = [];
        session.meta.sessionStartedAt = now;
      }
    }
  }
}
