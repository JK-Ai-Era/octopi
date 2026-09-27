/**
 * InMemorySessionStore — 内存存储
 *
 * 用于测试和临时场景。数据不持久化。
 * 键 = sessionId（Session 一等；同 id 多 agent 共享同一 Session 对象）。
 *
 * @layer harness/session — Session 域纯内存默认实现（非生产落盘后端）。
 */

import type { SessionStore, SessionListFilter } from '../../core/interfaces/session-store.js';
import type { SessionMeta, SessionAgentMatchPick } from '../../core/types.js';
import { sessionMatchesAgent } from '../../core/types/session.js';
import type { SessionData } from './types.js';

function toIndexPick(s: SessionData): SessionAgentMatchPick & { agentId: string } {
  return {
    agentId: s.agentId ?? s.meta.agentId,
    primaryAgentId: s.primaryAgentId ?? s.meta.primaryAgentId,
    preferredAgentId: s.preferredAgentId ?? s.meta.preferredAgentId,
    participantAgentIds:
      s.meta.participantAgentIds ??
      (s.participants ?? []).map((p) => p.agentId),
  };
}

export class InMemorySessionStore implements SessionStore<SessionData> {
  private sessions = new Map<string, SessionData>();

  async load(sessionId: string): Promise<SessionData | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async save(sessionId: string, data: SessionData): Promise<void> {
    this.sessions.set(sessionId, { ...data, id: sessionId });
  }

  async list(filter?: SessionListFilter): Promise<SessionMeta[]> {
    const values = Array.from(this.sessions.values());
    return values
      .filter((s) => (filter?.agentId ? sessionMatchesAgent(toIndexPick(s), filter.agentId) : true))
      .map((s) => ({
        ...s.meta,
        primaryAgentId: s.primaryAgentId ?? s.meta.primaryAgentId,
        preferredAgentId: s.preferredAgentId ?? s.meta.preferredAgentId,
        participantAgentIds: toIndexPick(s).participantAgentIds,
      }));
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
