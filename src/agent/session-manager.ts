import { randomUUID } from 'node:crypto';
import type { SessionMeta, Message, Turn } from '../core/types.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Session 管理器
 *
 * 参考 OpenClaw 的设计：
 * - sessions.json 存元数据
 * - <sessionId>.jsonl 存对话记录
 * - Session write lock 保证同一 session 串行
 * - Daily/Idle reset 自动新建 session
 */
export class SessionManager {
  private sessions = new Map<string, SessionMeta>();
  private messages = new Map<string, Message[]>();
  private turns = new Map<string, Turn[]>();
  private locks = new Map<string, () => void>();
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? '.agent-harness/sessions';
  }

  // ---- Session CRUD ----

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
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    this.turns.set(session.id, []);
    this.persistMeta(session);
    return session;
  }

  get(id: string): SessionMeta | undefined {
    return this.sessions.get(id);
  }

  /**
   * 查找活跃 session（OpenClaw 路由逻辑）
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
          continue;
        }
        return session;
      }
    }
    return undefined;
  }

  private isSessionExpired(session: SessionMeta): boolean {
    const now = Date.now();
    // Daily reset: 超过 24 小时
    const dailyAge = now - session.sessionStartedAt;
    if (dailyAge > 24 * 60 * 60 * 1000) return true;
    // Idle reset: 2 小时无交互
    const idleAge = now - session.lastInteractionAt;
    if (idleAge > 2 * 60 * 60 * 1000) return true;
    return false;
  }

  // ---- Messages ----

  addMessage(sessionId: string, message: Message): void {
    const msgs = this.messages.get(sessionId);
    if (msgs) {
      msgs.push(message);
    }
    // 持久化到 JSONL
    this.persistTranscript(sessionId, message);
  }

  getMessages(sessionId: string): Message[] {
    return this.messages.get(sessionId) ?? [];
  }

  addTurn(sessionId: string, turn: Turn): void {
    const turns = this.turns.get(sessionId);
    if (turns) {
      turns.push(turn);
    }
  }

  getTurns(sessionId: string): Turn[] {
    return this.turns.get(sessionId) ?? [];
  }

  // ---- Session Write Lock ----

  /**
   * 获取 session 写锁（OpenClaw 设计：同一 session 同时只有一个运行）
   * 返回释放函数
   */
  async acquireLock(sessionId: string, timeoutMs: number = 60000): Promise<() => void> {
    const existing = this.locks.get(sessionId);
    if (!existing) {
      // 没有锁，直接获取
      let releaseFn: () => void;
      const promise = new Promise<void>((resolve) => {
        releaseFn = () => {
          this.locks.delete(sessionId);
          resolve();
        };
      });
      this.locks.set(sessionId, releaseFn!);
      return releaseFn!;
    }

    // 有锁，等待释放
    return new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Session ${sessionId} write lock timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const checkLock = () => {
        if (!this.locks.has(sessionId)) {
          clearTimeout(timer);
          let releaseFn: () => void;
          this.locks.set(sessionId, () => {
            this.locks.delete(sessionId);
          });
          resolve(() => this.locks.delete(sessionId));
        } else {
          setTimeout(checkLock, 100);
        }
      };
      checkLock();
    });
  }

  // ---- Persistence ----

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
    } catch {
      // 持久化失败不阻塞主流程
    }
  }

  private persistTranscript(sessionId: string, message: Message): void {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      const dir = join(this.dataDir, session.agentId);
      mkdirSync(dir, { recursive: true });
      const transcriptFile = join(dir, `${sessionId}.jsonl`);
      appendFileSync(transcriptFile, JSON.stringify(message) + '\n');
    } catch {
      // 持久化失败不阻塞主流程
    }
  }
}
