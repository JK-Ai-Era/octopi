/**
 * SessionStore — Session 持久化接口（泛型）
 *
 * @layer core — 定义最抽象的 session 存取契约。
 * 具体的 SessionData 结构由 harness 层定义。
 *
 * 设计要点：
 * - Core 层不使用此接口（Agent 无状态）
 * - Harness 层的 SessionAwareRunner 使用此接口
 * - 放在 Core 层是为了让所有层都能引用此类型
 */

import type { SessionMeta } from '../types.js';

/**
 * SessionStore 接口
 *
 * @typeParam T - Session 数据类型，由 harness 层具体化（如 SessionData）
 */
export interface SessionStore<T = unknown> {
  /** 加载 session 数据（不存在返回 null） */
  load(sessionId: string): Promise<T | null>;

  /** 保存 session 数据（覆盖写入） */
  save(sessionId: string, data: T): Promise<void>;

  /** 列出 agent 下的所有 session 元数据 */
  list(agentId: string): Promise<SessionMeta[]>;

  /** 删除 session */
  delete(sessionId: string): Promise<void>;

  /** 检查 session 是否存在 */
  exists(sessionId: string): Promise<boolean>;
}
