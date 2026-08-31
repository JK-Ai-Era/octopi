/**
 * InMemorySessionStore — 内存存储
 *
 * 用于测试和临时场景。数据不持久化。
 */

import type { SessionStore } from '../../core/interfaces/session-store.js';
import type { SessionData } from '../../harness/session-types.js';
import type { SessionMeta } from '../../core/types.js';

export class InMemorySessionStore implements SessionStore<SessionData> {
  private sessions = new Map<string, SessionData>();

  async load(sessionId: string): Promise<SessionData | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async save(sessionId: string, data: SessionData): Promise<void> {
    this.sessions.set(sessionId, { ...data });
  }

  async list(agentId: string): Promise<SessionMeta[]> {
    return Array.from(this.sessions.values())
      .filter(s => s.agentId === agentId)
      .map(s => s.meta);
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async exists(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }

  /** 清空所有数据（测试用） */
  clear(): void {
    this.sessions.clear();
  }
}
