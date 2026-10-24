/**
 * InMemorySessionStore — 内存存储
 *
 * 用于测试和临时场景。数据不持久化。
 * 键 = sessionId（Session 一等；同 id 多 agent 共享同一 Session 对象）。
 *
 * @layer harness/session — Session 域纯内存默认实现（非生产落盘后端）。
 */

import type { SessionStore, SessionListFilter } from '@octopi-agent/core/interfaces/session-store.js';
import type { SessionMeta, SessionAgentMatchPick } from '@octopi-agent/core/types.js';
import { readTitleState, sessionMatchesAgent } from '@octopi-agent/core/types/session.js';
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
    const prev = this.sessions.get(sessionId);
    if (!prev) return null;
    // 与 JsonlSessionStore.load 同口径：meta 是投影（标题三键权威在 metadata，
    // updateMetadata 写后 load().meta 立即新鲜，与索引后端行为一致）
    return { ...prev, meta: { ...prev.meta, ...readTitleState(prev.metadata) } };
  }

  async save(sessionId: string, data: SessionData): Promise<void> {
    const prev = this.sessions.get(sessionId);
    // 与 JsonlSessionStore 对齐：已有会话的 metadata 浅合并，删键走 updateMetadata
    const metadata = {
      ...(prev?.metadata ?? {}),
      ...(data.metadata ?? {}),
    };
    // 与 JsonlSessionStore 对齐：标题三键按 titleUpdatedAt 仲裁，陈旧值不回滚更新写入；
    // incoming 缺时间戳视为陈旧（写端恒打三键），同样归磁盘胜
    const freshTitle = readTitleState(prev?.metadata);
    const incomingTitle = readTitleState(data.metadata);
    if (
      freshTitle.titleUpdatedAt !== undefined &&
      (incomingTitle.titleUpdatedAt === undefined ||
        incomingTitle.titleUpdatedAt < freshTitle.titleUpdatedAt)
    ) {
      metadata.title = freshTitle.title;
      metadata.titleSource = freshTitle.titleSource;
      metadata.titleUpdatedAt = freshTitle.titleUpdatedAt;
    }
    this.sessions.set(sessionId, { ...data, id: sessionId, metadata });
  }

  async updateMetadata(
    sessionId: string,
    mutate: (meta: Record<string, unknown>) => void | Record<string, unknown>,
  ): Promise<void> {
    const prev = this.sessions.get(sessionId);
    if (!prev) return;
    const meta: Record<string, unknown> = { ...prev.metadata };
    const replaced = mutate(meta);
    this.sessions.set(sessionId, {
      ...prev,
      metadata: replaced === undefined ? meta : replaced,
    });
  }

  /**
   * 消息序列对齐。契约见 SessionStore.syncMessages；
   * 内存后端直接替换消息数组（与 JsonlSessionStore 同口径：不存在则跳过）。
   */
  async syncMessages(sessionId: string, messages: readonly unknown[]): Promise<void> {
    const prev = this.sessions.get(sessionId);
    if (!prev) return;
    this.sessions.set(sessionId, {
      ...prev,
      messages: messages.slice() as SessionData['messages'],
    });
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
        // 与 JsonlSessionStore.buildIndexEntry 同规则：置顶权威在 metadata.pinnedAt
        pinnedAt:
          typeof s.metadata?.pinnedAt === 'number' && Number.isFinite(s.metadata.pinnedAt)
            ? s.metadata.pinnedAt
            : s.meta.pinnedAt,
        // 与 JsonlSessionStore.buildIndexEntry 同规则：标题权威在 metadata 三键（无旧数据回退）
        ...readTitleState(s.metadata),
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
