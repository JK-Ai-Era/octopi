/**
 * InMemorySessionStore — 内存存储
 *
 * 用于测试和临时场景。数据不持久化。
 */

import type { SessionStore } from '../../core/interfaces/session-store.js';
import type { SessionData } from '../../harness/session-types.js';
import type { SessionMeta } from '../../core/types.js';

export class InMemorySessionStore implements SessionStore<SessionData> {
  /** 复合 key：agentId:sessionId，确保多 agent 场景不串数据 */
  private static key(agentId: string, sessionId: string): string {
    return `${agentId}:${sessionId}`;
  }

  private sessions = new Map<string, SessionData>();

  async load(agentId: string, sessionId: string): Promise<SessionData | null> {
    return this.sessions.get(InMemorySessionStore.key(agentId, sessionId)) ?? null;
  }

  async save(agentId: string, sessionId: string, data: SessionData): Promise<void> {
    this.sessions.set(InMemorySessionStore.key(agentId, sessionId), { ...data });
  }

  async list(agentId: string): Promise<SessionMeta[]> {
    return Array.from(this.sessions.values())
      .filter(s => s.agentId === agentId)
      .map(s => s.meta);
  }

  async delete(agentId: string, sessionId: string): Promise<void> {
    this.sessions.delete(InMemorySessionStore.key(agentId, sessionId));
  }

  async exists(agentId: string, sessionId: string): Promise<boolean> {
    return this.sessions.has(InMemorySessionStore.key(agentId, sessionId));
  }

  /** 清空所有数据（测试用） */
  clear(): void {
    this.sessions.clear();
  }
}
