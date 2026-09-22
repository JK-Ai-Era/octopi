/**
 * Session 类型定义
 *
 * @layer harness — Session 的具体结构和生命周期管理类型。
 * Core 层的 SessionStore 接口是泛型的，不引用此文件。
 */

import type { Message, Turn, SessionMeta } from '../core/types.js';
import type { SessionTask } from './session-tasks/types.js';
import type { ContextCompactSnapshot } from './context/types.js';
import type { SessionParticipant } from './session-acl/types.js';
import type { PrincipalRef } from './session-acl/types.js';

/** preferred / handoff 切换审计记录（I3/I6） */
export interface SessionSwitchRecord extends PrincipalRef {
  at: number;
  mode: 'preferred' | 'handoff';
  toAgentId: string;
  fromPreferredAgentId?: string;
  fromPrimaryAgentId?: string;
  toPrimaryAgentId?: string;
  reason?: string;
}

/** Session 生命周期状态 */
export type SessionLifecycleStatus = 'active' | 'recent' | 'extracted' | 'archived';

/**
 * Session 上的记忆处理状态（生命周期元数据字段）
 *
 * 仅表示「本 session 是否已被记忆旁路处理过」，**不是** 已删除的
 * ETL API（MemoryExtractorBridge / PendingExtractor / MemoryExtractionWiring）。
 * 补录/治理见 `memory.steward.*`（docs/memory-system-redesign.md）。
 */
export type MemoryExtractionStatus = 'pending' | 'completed' | 'skipped';

/** Session 生命周期元数据 */
export interface SessionLifecycleMeta {
  lifecycle: SessionLifecycleStatus;
  /** 见 MemoryExtractionStatus 注释：session 级处理标记，非 ETL 句柄 */
  memoryExtraction: MemoryExtractionStatus;
  endedAt?: number;
  archivedAt?: number;
}

/** Session 完整数据 */
export interface SessionData {
  id: string;
  /**
   * 创建/归属 agentId（归因字段与 list 过滤投影；单 agent 时 == primaryAgentId）。
   * **存储主键是 sessionId**，本字段不再决定物理路径。
   */
  agentId: string;
  /**
   * 主责 Agent（模型 2 · Accountability）。
   *
   * create 时写入创建方 agentId；历史数据缺省时 Runner 会回填为 `agentId`。
   * 执行切换（preferred / guest run）**不**自动改本字段；handoff 才改（I3）。
   */
  primaryAgentId?: string;
  /**
   * Activation 缺省执行者（I3：Agency，≠ Accountability）。
   * Trigger 未指明 agent 时 Runtime 可 resolve 到本字段；引擎**不**把它改成 primary。
   */
  preferredAgentId?: string;
  /** preferred / handoff 切换审计（I6 Principal 进审计） */
  switchAudit?: SessionSwitchRecord[];
  meta: SessionMeta;
  messages: Message[];
  turns: Turn[];
  metadata: Record<string, unknown>;
  lifecycle?: SessionLifecycleMeta;
  /**
   * 会话任务（goal/step 两级）。见 docs/task-system.md。
   * 历史数据可能缺省；Service/Runner 会视作 []。
   */
  tasks?: SessionTask[];
  /**
   * 上下文压缩状态快照（primary / 单 agent 兼容视图）。
   * 多 agent 权威桶见 `contextCompacts[agentId]`（E4 键 = session × agent）。
   */
  contextCompact?: ContextCompactSnapshot;
  /**
   * 模型 2：compact 分桶。键 = agentId；语义键 = `(sessionId, agentId)`。
   * 不挂在 Agent 模板上；不同 agent 不互相借用。
   */
  contextCompacts?: Record<string, ContextCompactSnapshot>;
  /**
   * Session×Agent 参与绑定（Phase E ACL）。
   * 角色目录见 harness/session-acl；effective = L0 ∩ role.max ∩ agent.max ∩ 绑定。
   */
  participants?: SessionParticipant[];
}
