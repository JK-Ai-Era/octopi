/**
 * SessionTask — 会话任务类型
 *
 * 两级结构（depth=1）：
 * - goal：parentId 为空，用户级委托
 * - step：parentId 指向 goal，执行计划项
 *
 * @layer harness — 挂在 SessionData.tasks 上，不是独立持久化域。
 */

/** 会话任务状态 */
export type SessionTaskStatus = 'open' | 'paused' | 'done' | 'dropped';

/** 会话任务条目 */
export interface SessionTask {
  id: string;
  /** 空/缺省 → goal；有值 → 所属 goal 的 step */
  parentId?: string;
  description: string;
  status: SessionTaskStatus;
  /** Agent 维护的简短进展，仅展示用 */
  progressNote?: string;
  /** step 展示顺序；goal 可忽略 */
  order?: number;
  createdAt: number;
  updatedAt: number;
}

/** 任务事件类型 */
export type SessionTaskEventType =
  | 'session.task.snapshot'
  | 'session.task.created'
  | 'session.task.updated';

/** 未闭合状态（注入与 listActive 使用） */
export const ACTIVE_SESSION_TASK_STATUSES: readonly SessionTaskStatus[] = ['open', 'paused'];
