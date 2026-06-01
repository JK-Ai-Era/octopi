/**
 * Session 管理器
 *
 * 负责 Session 的完整生命周期管理：
 * - 创建/查找/销毁 session
 * - 消息和 turn 记录的内存管理 + JSONL 持久化
 * - Session write lock（同一 session 同时只有一个运行）
 * - Daily reset 和 Idle reset
 *
 * 存储结构：
 *   .octopi/sessions/
 *     <agentId>/
 *       sessions.json          ← 所有 session 的元数据
 *       <sessionId>.jsonl      ← 每个 session 的对话记录（JSONL 格式）
 */

import { randomUUID } from 'node:crypto';
import type { SessionMeta, Message, Turn } from '../core/types.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Session 管理器
 *
 * 核心职责：
 * 1. Session 路由：根据 agentId + peerKey 找到或创建 session
 * 2. Write lock：保证同一 session 同时只有一个 Agent Loop 在运行
 * 3. 消息管理：维护内存中的消息列表 + JSONL 持久化
 * 4. 生命周期：daily reset（24h）和 idle reset（2h 无交互）
 */
export class SessionManager {
  /** session 元数据（内存缓存） */
  private sessions = new Map<string, SessionMeta>();
  /** session 消息列表（内存缓存） */
  private messages = new Map<string, Message[]>();
  /** session turn 列表（内存缓存） */
  private turns = new Map<string, Turn[]>();
  /** session write lock（sessionId → release 函数） */
  private locks = new Map<string, () => void>();
  /** 数据持久化目录 */
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? '.octopi/sessions';
  }

  // ================================================================
  // Session CRUD
  // ================================================================

  /**
   * 创建新 session
   *
   * @param params.agentId - 所属 agent ID
   * @param params.channelId - 渠道 ID
   * @param params.peerId - 对等方标识（由 dmScope 决定格式）
   * @returns 新创建的 session 元数据
   */
  create(params: {
    agentId: string;
    channelId: string;
    peerId: string;
  }): SessionMeta {
    const now = Date.now();
    const session: SessionMeta = {
      id: randomUUID(),
      agentId: params.agentId,
      channelId: params.channelId,
      peerId: params.peerId,
      status: 'idle',
      createdAt: now,
      sessionStartedAt: now,
      lastInteractionAt: now,
      updatedAt: now,
    };

    // 内存缓存
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    this.turns.set(session.id, []);

    // 持久化元数据
    this.persistMeta(session);

    console.log(`[SessionManager] Created session ${session.id} for agent=${params.agentId} peer=${params.peerId}`);
    return session;
  }

  /**
   * 根据 ID 获取 session
   */
  get(id: string): SessionMeta | undefined {
    return this.sessions.get(id);
  }

  /**
   * 查找活跃 session（OpenClaw 路由逻辑）
   *
   * 根据 agentId + peerKey 查找未过期的 session。
   * 如果 session 已过期（daily/idle reset），返回 undefined。
   *
   * @param agentId - agent ID
   * @param peerKey - 对等方标识
   * @returns 找到的 session，或 undefined
   */
  findActive(agentId: string, peerKey: string): SessionMeta | undefined {
    for (const session of this.sessions.values()) {
      if (
        session.agentId === agentId &&
        session.peerId === peerKey &&
        session.status !== 'error'
      ) {
        // 检查是否过期
        if (this.isSessionExpired(session)) {
          console.log(`[SessionManager] Session ${session.id} expired, skipping`);
          continue;
        }
        return session;
      }
    }
    return undefined;
  }

  /**
   * 判断 session 是否过期
   *
   * 过期条件（满足任一）：
   * - 距离 session 开始超过 24 小时（daily reset）
   * - 距离最后交互超过 2 小时（idle reset）
   */
  private isSessionExpired(session: SessionMeta): boolean {
    const now = Date.now();

    // Daily reset: 超过 24 小时
    const dailyAge = now - session.sessionStartedAt;
    if (dailyAge > 24 * 60 * 60 * 1000) {
      return true;
    }

    // Idle reset: 2 小时无交互
    const idleAge = now - session.lastInteractionAt;
    if (idleAge > 2 * 60 * 60 * 1000) {
      return true;
    }

    return false;
  }

  // ================================================================
  // 消息管理
  // ================================================================

  /**
   * 添加消息到 session
   *
   * 同时更新内存缓存和 JSONL 持久化文件。
   * 持久化失败不会阻塞主流程（graceful degradation）。
   */
  addMessage(sessionId: string, message: Message): void {
    const msgs = this.messages.get(sessionId);
    if (msgs) {
      msgs.push(message);
    }
    // 持久化到 JSONL
    this.persistTranscript(sessionId, message);
  }

  /**
   * 获取 session 的所有消息
   */
  getMessages(sessionId: string): Message[] {
    return this.messages.get(sessionId) ?? [];
  }

  /**
   * 添加 turn 记录
   */
  addTurn(sessionId: string, turn: Turn): void {
    const turns = this.turns.get(sessionId);
    if (turns) {
      turns.push(turn);
    }
  }

  /**
   * 获取 session 的所有 turn
   */
  getTurns(sessionId: string): Turn[] {
    return this.turns.get(sessionId) ?? [];
  }

  // ================================================================
  // Session Write Lock
  // ================================================================

  /**
   * 获取 session 写锁
   *
   * OpenClaw 的关键设计：同一 session 同时只有一个 Agent Loop 在运行。
   * 这避免了：
   * - 消息乱序（两条消息同时处理导致回复顺序错乱）
   * - 竞态条件（同时修改 session 状态）
   * - 重复回复（两条消息各触发一次 LLM 调用）
   *
   * 使用方式：
   * ```ts
   * const release = await sessionManager.acquireLock(sessionId);
   * try {
   *   // ... 处理消息
   * } finally {
   *   release();
   * }
   * ```
   *
   * @param sessionId - session ID
   * @param timeoutMs - 获取锁的超时时间（默认 60 秒）
   * @returns 释放锁的函数
   * @throws 超时时抛出错误
   */
  async acquireLock(sessionId: string, timeoutMs: number = 60000): Promise<() => void> {
    const existing = this.locks.get(sessionId);

    if (!existing) {
      // 没有锁，直接获取
      const releaseFn = () => {
        this.locks.delete(sessionId);
      };
      this.locks.set(sessionId, releaseFn);
      return releaseFn;
    }

    // 有锁，等待释放（轮询方式）
    // TODO: 改用更高效的等待机制（如 Promise 队列）
    return new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Session ${sessionId} write lock timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const checkLock = () => {
        if (!this.locks.has(sessionId)) {
          clearTimeout(timer);
          const releaseFn = () => {
            this.locks.delete(sessionId);
          };
          this.locks.set(sessionId, releaseFn);
          resolve(releaseFn);
        } else {
          setTimeout(checkLock, 100);
        }
      };
      checkLock();
    });
  }

  // ================================================================
  // 持久化
  // ================================================================

  /**
   * 持久化 session 元数据
   *
   * 写入 <dataDir>/<agentId>/sessions.json
   * 格式：{ [sessionId]: SessionMeta }
   */
  private persistMeta(session: SessionMeta): void {
    try {
      const dir = join(this.dataDir, session.agentId);
      mkdirSync(dir, { recursive: true });

      const metaFile = join(dir, 'sessions.json');
      let sessions: Record<string, SessionMeta> = {};

      if (existsSync(metaFile)) {
        sessions = JSON.parse(readFileSync(metaFile, 'utf-8'));
      }

      sessions[session.id] = session;
      writeFileSync(metaFile, JSON.stringify(sessions, null, 2));
    } catch (error) {
      // 持久化失败不阻塞主流程
      console.error(`[SessionManager] Failed to persist meta for session ${session.id}:`, error);
    }
  }

  /**
   * 持久化消息到 JSONL 文件
   *
   * 每行一个 JSON 对象，追加写入。
   * 格式与 OpenClaw 的 transcript 格式一致。
   *
   * 文件路径：<dataDir>/<agentId>/<sessionId>.jsonl
   */
  private persistTranscript(sessionId: string, message: Message): void {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) return;

      const dir = join(this.dataDir, session.agentId);
      mkdirSync(dir, { recursive: true });

      const transcriptFile = join(dir, `${sessionId}.jsonl`);
      appendFileSync(transcriptFile, JSON.stringify(message) + '\n');
    } catch (error) {
      console.error(`[SessionManager] Failed to persist transcript for session ${sessionId}:`, error);
    }
  }
}
