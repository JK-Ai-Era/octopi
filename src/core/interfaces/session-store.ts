/**
 * SessionStore — Session 持久化接口
 *
 * 职责：Session 数据的持久化和检索。
 * 实现方：文件系统、Redis、SQLite、内存等。
 *
 * 设计要点：
 * - Core 层不使用此接口（AgentEngine 无状态）
 * - Harness 层的 SessionAwareRunner 使用此接口
 * - 放在 Core 层是为了让所有层都能引用此类型
 */

import type { Message, Turn, SessionMeta } from '../types.js';

// ── Session 数据 ──

/** Session 完整数据 */
export interface SessionData {
  /** Session 唯一 ID */
  id: string;
  /** 所属 Agent ID */
  agentId: string;
  /** Session 元数据 */
  meta: SessionMeta;
  /** 消息历史 */
  messages: Message[];
  /** Turn 记录 */
  turns: Turn[];
  /** 扩展元数据 */
  metadata: Record<string, unknown>;
}

// ── 接口定义 ──

/**
 * SessionStore 接口
 *
 * Harness 层的 SessionAwareRunner 使用。
 */
export interface SessionStore {
  /** 加载 session 数据（不存在返回 null） */
  load(sessionId: string): Promise<SessionData | null>;

  /** 保存 session 数据（覆盖写入） */
  save(sessionId: string, data: SessionData): Promise<void>;

  /** 列出 agent 下的所有 session 元数据 */
  list(agentId: string): Promise<SessionMeta[]>;

  /** 删除 session */
  delete(sessionId: string): Promise<void>;

  /** 检查 session 是否存在 */
  exists(sessionId: string): Promise<boolean>;
}
