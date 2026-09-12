/**
 * Session 类型定义
 *
 * @layer harness — Session 的具体结构和生命周期管理类型。
 * Core 层的 SessionStore 接口是泛型的，不引用此文件。
 */

import type { Message, Turn, SessionMeta } from '../core/types.js';
import type { SessionTask } from './session-tasks/types.js';

/** Session 生命周期状态 */
export type SessionLifecycleStatus = 'active' | 'recent' | 'extracted' | 'archived';

/** Memory 提取状态 */
export type MemoryExtractionStatus = 'pending' | 'completed' | 'skipped';

/** Session 生命周期元数据 */
export interface SessionLifecycleMeta {
  lifecycle: SessionLifecycleStatus;
  memoryExtraction: MemoryExtractionStatus;
  endedAt?: number;
  archivedAt?: number;
}

/** Session 完整数据 */
export interface SessionData {
  id: string;
  agentId: string;
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
}
