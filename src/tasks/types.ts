/**
 * Task Management System — 类型定义
 *
 * TaskTracker：纯状态管理（CRUD + 持久化）
 * TaskManager LLM：轻量决策模型
 * TaskManagerPlugin：Hook 集成
 */

/** 任务状态 */
export type TaskStatus =
  | 'in_progress'   // 正在执行
  | 'interrupted'   // 被新消息打断，等待用户确认
  | 'completed'     // 完成
  | 'cancelled';    // 用户说不做了

/** 任务事件类型 */
export type TaskAction =
  | 'create'        // 创建任务
  | 'start'         // 开始执行
  | 'interrupt'     // 被打断
  | 'resume'        // 恢复执行
  | 'complete'      // 完成
  | 'cancel';       // 取消

/** 任务定义 */
export interface Task {
  id: string;
  sessionId: string;
  description: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

/** 任务事件（持久化用） */
export interface TaskEvent {
  action: TaskAction;
  taskId: string;
  sessionId: string;
  description?: string;
  reason?: string;
  timestamp: number;
}

/** TaskManager LLM 的输入 */
export interface TaskDecisionInput {
  sessionId: string;
  currentTasks: Task[];
  newMessage: string;
  recentContext: string; // 最近几条消息摘要
}

/** TaskManager LLM 的输出 */
export interface TaskDecision {
  /** 是否给主 LLM 注入任务上下文 */
  injectTaskContext: boolean;
  /** 注入的内容（描述 + 进展） */
  taskContext: string;
  /** 哪些任务被打断 */
  interruptedTasks: string[];
  /** 是否新建任务（描述） */
  newTask: string | null;
  /** 是否完成某个任务 */
  completesTask: string | null;
  /** 是否恢复某个被中断的任务 */
  resumeTask: string | null;
  /** 决策理由 */
  reason: string;
}

/** TaskTracker 接口 */
export interface TaskTracker {
  /** 创建任务 */
  create(sessionId: string, description: string): Task;
  /** 开始执行 */
  start(taskId: string): void;
  /** 打断任务 */
  interrupt(taskId: string, reason: string): void;
  /** 恢复任务 */
  resume(taskId: string): void;
  /** 完成任务 */
  complete(taskId: string): void;
  /** 取消任务 */
  cancel(taskId: string): void;
  /** 获取 session 的所有任务 */
  getBySession(sessionId: string): Task[];
  /** 获取 session 的活跃任务（in_progress + interrupted） */
  getActiveTasks(sessionId: string): Task[];
  /** 获取 session 的被中断任务 */
  getInterruptedTasks(sessionId: string): Task[];
}

/** TaskManager Plugin 配置 */
export interface TaskManagerConfig {
  /** 是否启用任务管理 */
  enabled: boolean;
  /** TaskManager LLM 的 provider 名称 */
  provider: string;
  /** TaskManager LLM 的模型名称 */
  model: string;
  /** 数据目录（用于持久化） */
  dataDir?: string;
}
