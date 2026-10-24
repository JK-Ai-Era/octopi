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

  /**
   * 按 sessionId 覆盖写入。
   *
   * 对已存在会话，`metadata` 与磁盘现值浅合并（调用方键优先）；
   * **删 metadata 键必须走 `updateMetadata`**。长驻 run 对象上的陈旧
   * `metadata` 不得抹掉并发写入的键（如 clientToolCalls / fileReleases）。
   * 标题三键（title / titleSource / titleUpdatedAt）例外：按 `titleUpdatedAt`
   * 新旧仲裁——陈旧值不得回滚并发写入的更新标题（浅合并只护「缺键」，不护「旧值」）。
   */
  save(sessionId: string, data: T): Promise<void>;

  /**
   * 会话 metadata 原子读改写（支持删键）。
   *
   * 与 `save` 同会话串行。`mutate` 原地改或返回替换对象；
   * 返回 `undefined` 表示使用原地修改结果。
   */
  updateMetadata?(
    sessionId: string,
    mutate: (meta: Record<string, unknown>) => void | Record<string, unknown>,
  ): Promise<void>;

  /**
   * 将持久化消息序列对齐为 `messages`（Run 进行中的转录增量落盘通道）。
   *
   * 语义 = 「load().messages 等于给定序列」：实现应优先增量追加，检测到漂移
   * （旁路整包 save / 外部改动 / 前缀分歧）时退化为整文件对齐。幂等：重复
   * 调用同一序列（同一引用前缀）不得产生额外写。
   *
   * 调用方契约：
   * - 只传「已定形、应落历史」的消息（与收尾 `save` 的落历史口径一致，
   *   ephemeral 运行期消息不得包含）；
   * - 已同步前缀不得再原地修改消息对象（需要修改即视为新序列，实现按
   *   分歧处理）。
   *
   * 与 `save` 同会话串行。元素仅按 JSON 序列化持久化，结构由 harness 层定义。
   */
  syncMessages?(sessionId: string, messages: readonly unknown[]): Promise<void>;

  /** 列出 session 元数据；可选按参与 agent 过滤 */
  list(filter?: SessionListFilter): Promise<SessionMeta[]>;

  /** 按 sessionId 删除 */
  delete(sessionId: string): Promise<void>;

  /** 按 sessionId 检查是否存在 */
  exists(sessionId: string): Promise<boolean>;
}
