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
  agentId: string;
  channelId: string;
  peerId: string;
  status: SessionStatus;
  createdAt: number;
  sessionStartedAt: number;
  lastInteractionAt: number;
  updatedAt: number;
}
