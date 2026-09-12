/**
 * task_create / task_list / task_update 工具 — Agent 任务管理
 *
 * 通过工厂函数接收 TaskTracker 实例（闭包注入），消除 context.services 类型黑洞。
 */

import type { RegisteredTool, ToolExecutionContext } from '../../../core/types.js';
import type { TaskTracker as ITaskTracker, TaskStatus } from '../../task-system/tasks/types.js';

/** 创建任务工具集 */
export function createTaskTools(tracker: ITaskTracker): RegisteredTool[] {
  return [createTaskCreateTool(tracker), createTaskListTool(tracker), createTaskUpdateTool(tracker)];
}

/** task_create 工具 — 创建任务 */
export function createTaskCreateTool(tracker: ITaskTracker): RegisteredTool {
  return {
    definition: {
      name: 'task_create',
      description: 'Create a new task for tracking multi-step work. Returns the task ID for future reference.',
      parameters: {
        description: { type: 'string', description: 'Task description — what needs to be done', required: true },
      },
    },
    handler: async (args, context) => {
      const task = await tracker.create(context.sessionId, args.description as string);
      return { id: task.id, description: task.description, status: task.status, createdAt: task.createdAt };
    },
  };
}

/** task_list 工具 — 列出当前 session 的任务 */
export function createTaskListTool(tracker: ITaskTracker): RegisteredTool {
  return {
    definition: {
      name: 'task_list',
      description: 'List tasks in the current session. Optionally filter by status.',
      parameters: {
        status: { type: 'string', description: 'Filter by status (default: all)', enum: ['in_progress', 'interrupted', 'completed', 'cancelled'] },
      },
    },
    handler: async (args, context) => {
      const allTasks = tracker.getBySession(context.sessionId);
      const statusFilter = args.status as TaskStatus | undefined;
      const tasks = statusFilter ? allTasks.filter((t) => t.status === statusFilter) : allTasks;
      return {
        tasks: tasks.map((t) => ({ id: t.id, description: t.description, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt })),
        total: tasks.length,
        active: tracker.getActiveTasks(context.sessionId).length,
      };
    },
  };
}

/** task_update 工具 — 更新任务状态 */
export function createTaskUpdateTool(tracker: ITaskTracker): RegisteredTool {
  return {
    definition: {
      name: 'task_update',
      description: 'Update a task status: complete, cancel, interrupt, resume, or restart.',
      parameters: {
        task_id: { type: 'string', description: 'The task ID to update', required: true },
        action: { type: 'string', description: 'The action to perform', required: true, enum: ['complete', 'cancel', 'interrupt', 'resume', 'start'] },
        reason: { type: 'string', description: 'Reason for the status change (optional)' },
      },
    },
    handler: async (args, context) => {
      const taskId = args.task_id as string;
      const action = args.action as string;
      const reason = (args.reason as string) ?? '';

      const task = tracker.getBySession(context.sessionId).find((t) => t.id === taskId);
      if (!task) throw new Error();

      switch (action) {
        case 'complete': await tracker.complete(taskId); break;
        case 'cancel': await tracker.cancel(taskId); break;
        case 'interrupt': await tracker.interrupt(taskId, reason); break;
        case 'resume': await tracker.resume(taskId); break;
        case 'start': await tracker.start(taskId); break;
        default: throw new Error();
      }
      return { id: taskId, previousStatus: task.status, action, reason: reason || undefined };
    },
  };
}
