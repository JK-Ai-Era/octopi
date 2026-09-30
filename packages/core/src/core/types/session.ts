/**
 * Session 类型
 *
 * @layer core — 只包含跨层通用的 Session 类型。
 * 生命周期管理类型在 harness/ 或 integration/ 层定义。
 */

/** Session 运行状态 */
export type SessionStatus = 'idle' | 'processing' | 'waiting_human' | 'error';

/** Session 元数据 */
export interface SessionMeta {
  id: string;
  /** 创建/归属 agent（兼容与展示；存储主键为 sessionId） */
  agentId: string;
  channelId: string;
  peerId: string;
  status: SessionStatus;
  createdAt: number;
  sessionStartedAt: number;
  lastInteractionAt: number;
  updatedAt: number;
  /** Accountability（模型 2）；列表过滤 / 缺省人设 */
  primaryAgentId?: string;
  /** Activation preferred；列表过滤 */
  preferredAgentId?: string;
  /** 参与者 agentId（列表过滤；完整绑定在 SessionData.participants） */
  participantAgentIds?: string[];
  /**
   * 会话运行状态投影（I2：可从 SessionData 重建；供 list 过滤/归档扫描）。
   * 与 SessionData.lifecycle 同源，由 SessionStore save 时写入索引。
   */
  lifecycle?: 'active' | 'recent' | 'archived';
  endedAt?: number;
  archivedAt?: number;
}

/** Session 归属匹配输入（SessionMeta / SessionData 的 agent 投影） */
export interface SessionAgentMatchPick {
  agentId?: string;
  primaryAgentId?: string;
  preferredAgentId?: string;
  participantAgentIds?: string[];
}

/**
 * meta.agentId / primary / preferred / participant 任一命中。
 *
 * 与 `SessionListFilter.agentId` 同一规则；存储实现与会话检索共用。
 *
 * @param pick - 会话 agent 投影
 * @param agentId - 目标 agent
 * @returns 是否命中
 */
export function sessionMatchesAgent(
  pick: SessionAgentMatchPick,
  agentId: string,
): boolean {
  return (
    pick.agentId === agentId ||
    pick.primaryAgentId === agentId ||
    pick.preferredAgentId === agentId ||
    (pick.participantAgentIds ?? []).includes(agentId)
  );
}
