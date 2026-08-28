/**
 * Session 类型
 */

/** Session 状态 */
export type SessionStatus = 'idle' | 'processing' | 'waiting_human' | 'error';

/** Session 元数据 */
export interface SessionMeta {
  id: string;
  agentId: string;
  channelId: string;
  peerId: string;
  status: SessionStatus;
  createdAt: number;
  sessionStartedAt: number;
  lastInteractionAt: number;
  updatedAt: number;
}
