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

import type { Message, Turn } from '../core/types.js';
import type { SessionStore, SessionData } from '../core/interfaces/session-store.js';
import type { AgentEngine, RunConfig, EngineEvent } from '../core/engine.js';

/** Session 锁 */
interface SessionLock {
  release: () => void;
}

/** 运行器配置 */
export interface SessionAwareRunnerConfig {
  /** Session 过期时间（毫秒，默认 24 小时） */
  sessionExpiryMs?: number;
  /** 空闲过期时间（毫秒，默认 2 小时） */
  idleExpiryMs?: number;
  /** 是否启用 daily reset */
  enableDailyReset?: boolean;
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
  private locks = new Map<string, SessionLock>();
  private config: SessionAwareRunnerConfig;

  constructor(engine: AgentEngine, store: SessionStore, config?: SessionAwareRunnerConfig) {
    this.engine = engine;
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 处理一条消息
   *
   * @param sessionId - Session 标识
   * @param input - 用户输入消息
   * @param runConfig - Agent 运行配置
   * @param signal - 中止信号
   * @yields EngineEvent 事件流
   */
  async *handle(
    sessionId: string,
    input: Message,
    runConfig: RunConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<EngineEvent> {
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
      session.meta.status = 'processing';

      // 5. 运行 AgentEngine
      for await (const event of this.engine.run(session.messages, runConfig, signal)) {
        yield event;

        // 如果是 turn.end，记录 turn
        if (event.type === 'turn.end' && event.data) {
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

      // 6. 持久化
      session.meta.status = 'idle';
      session.meta.updatedAt = Date.now();
      await this.store.save(sessionId, session);

    } finally {
      release();
    }
  }

  /**
   * 获取 Session 锁
   * 同一 session 同时只有一个运行
   */
  private async acquireLock(sessionId: string): Promise<() => void> {
    // 如果已有锁，等待释放
    while (this.locks.has(sessionId)) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    let released = false;
    const lock: SessionLock = {
      release: () => {
        if (!released) {
          released = true;
          this.locks.delete(sessionId);
        }
      },
    };

    this.locks.set(sessionId, lock);
    return lock.release;
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
