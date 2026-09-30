/**
 * SessionStore — Session 持久化接口（泛型）
 *
 * @layer core — 定义最抽象的 session 存取契约。
 * 具体的 SessionData 结构由 harness 层定义。
 *
 * 设计要点：
 * - Session 是连续性一等 ID；**存储主键 = sessionId**（不再按 agent 分目录/分键）
 * - 多 agent 参与同一 Session：primary / preferred / participants 在数据模型内
 * - Core 层不使用此接口（可运行状态在 Harness 的 Agent / Session）
 * - Harness 层的 SessionAwareRunner 使用此接口
 */

import type { SessionMeta } from '../types.js';

/** list 过滤条件 */
export interface SessionListFilter {
  /**
   * 只返回该 agent 参与的 session：
   * `meta.agentId` / `primaryAgentId` / `preferredAgentId` / `participantAgentIds` 任一命中。
   */
  agentId?: string;
}

/**
 * SessionStore 接口
 *
 * @typeParam T - Session 数据类型，由 harness 层具体化（如 SessionData）
 */
export interface SessionStore<T = unknown> {
  /** 按 sessionId 加载（一等键；不存在返回 null） */
  load(sessionId: string): Promise<T | null>;

  /** 按 sessionId 覆盖写入 */
  save(sessionId: string, data: T): Promise<void>;

  /** 列出 session 元数据；可选按参与 agent 过滤 */
  list(filter?: SessionListFilter): Promise<SessionMeta[]>;

  /** 按 sessionId 删除 */
  delete(sessionId: string): Promise<void>;

  /** 按 sessionId 检查是否存在 */
  exists(sessionId: string): Promise<boolean>;
}
