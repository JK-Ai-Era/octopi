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
  /**
   * 上下文压缩状态快照。
   * 全量 messages 仍完整保存；本字段用于重启后快速重建 LLM 视图。
   */
  contextCompact?: {
    summary?: string;
    lastProactiveMessageCount?: number;
    lastProactiveTokens?: number;
  };
}
