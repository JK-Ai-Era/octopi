/**
 * TaskStore — 任务持久化协议
 *
 * 职责：异步任务的状态持久化和检索。
 * 实现方：内存（开发）、文件、Redis、数据库等。
 *
 * 设计要点：
 * - Core 层的 AsyncTask 使用此接口持久化状态
 * - 支持任务查询和过滤（用于 dashboard/监控）
 * - 任务状态机：pending → running → completed | failed | cancelled
 */

// ── 任务状态 ──

/** 任务状态 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** 任务优先级 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

// ── 任务数据 ──

/** 任务记录 */
export interface TaskRecord {
  /** 任务唯一 ID */
  id: string;
  /** 所属 Agent ID */
  agentId: string;
  /** 所属 Session ID（可选） */
  sessionId?: string;
  /** 任务类型 */
  type: string;
  /** 任务状态 */
  status: TaskStatus;
  /** 任务优先级 */
  priority: TaskPriority;
  /** 任务输入 */
  input: unknown;
  /** 任务输出（完成后有值） */
  output?: unknown;
  /** 错误信息（失败时有值） */
  error?: string;
  /** 创建时间 */
  createdAt: number;
  /** 开始执行时间 */
  startedAt?: number;
  /** 完成时间 */
  completedAt?: number;
  /** 重试次数 */
  retryCount: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 超时时间（毫秒） */
  timeoutMs?: number;
  /** 父任务 ID（子任务场景） */
  parentId?: string;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

// ── 查询选项 ──

/** 任务查询过滤器 */
export interface TaskFilter {
  /** 按 Agent ID 过滤 */
  agentId?: string;
  /** 按 Session ID 过滤 */
  sessionId?: string;
  /** 按状态过滤 */
  status?: TaskStatus | TaskStatus[];
  /** 按类型过滤 */
  type?: string;
  /** 按父任务 ID 过滤 */
  parentId?: string;
  /** 创建时间范围 */
  createdAfter?: number;
  createdBefore?: number;
  /** 返回数量限制 */
  limit?: number;
  /** 偏移量 */
  offset?: number;
}

// ── 接口定义 ──

/**
 * TaskStore 接口
 *
 * Core 层的 AsyncTask 使用此接口持久化任务状态。
 */
export interface TaskStore {
  /**
   * 创建任务记录
   * @param task - 完整的任务记录（包含 id）
   * @returns 创建的任务 ID
   */
  create(task: TaskRecord): Promise<string>;

  /**
   * 更新任务记录（部分更新）
   */
  update(taskId: string, patch: Partial<TaskRecord>): Promise<void>;

  /**
   * 获取任务记录
   */
  get(taskId: string): Promise<TaskRecord | null>;

  /**
   * 查询任务
   */
  query(filter: TaskFilter): Promise<TaskRecord[]>;

  /**
   * 删除任务记录
   */
  delete(taskId: string): Promise<void>;

  /**
   * 清理过期任务
   * @param olderThanMs - 清理此时间之前完成的任务
   */
  cleanup(olderThanMs: number): Promise<number>;
}
