/**
 * task_* 工具 — 经 SessionTaskService 维护会话任务
 *
 * 写入唯一入口是 SessionTaskService；工具不直接碰 SessionStore。
 */

import type { RegisteredTool } from '../../core/types.js';
import type { SessionTaskService } from './service.js';
import type { SessionTaskStatus } from './types.js';

function taskSummary(task: {
  id: string;
  parentId?: string;
  description: string;
  status: string;
  progressNote?: string;
  order?: number;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    id: task.id,
    parent_id: task.parentId,
    description: task.description,
    status: task.status,
    progress_note: task.progressNote,
    order: task.order,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/** 创建 task_* 工具集 */
export function createSessionTaskTools(service: SessionTaskService): RegisteredTool[] {
  return [
    createTaskListTool(service),
    createTaskCreateTool(service),
    createTaskPlanTool(service),
    createTaskCompleteTool(service),
    createTaskPauseTool(service),
    createTaskResumeTool(service),
    createTaskDropTool(service),
    createTaskNoteTool(service),
  ];
}

export function createTaskListTool(service: SessionTaskService): RegisteredTool {
  return {
    definition: {
      name: 'task_list',
      description:
        'List session tasks (goals and steps). Goals have no parent_id; steps have parent_id of their goal.',
      parameters: {
        status: {
          type: 'string',
          description: 'Filter by status',
          enum: ['open', 'paused', 'done', 'dropped'],
        },
        parent_id: {
          type: 'string',
          description: 'Filter steps under a goal id; omit for all tasks',
        },
        active_only: {
          type: 'boolean',
          description: 'Only open and paused tasks (default false)',
        },
      },
    },
    handler: async (args, context) => {
      const status = args.status as SessionTaskStatus | undefined;
      const parentId = args.parent_id as string | undefined;
      const activeOnly = Boolean(args.active_only);
      const tasks = await service.listAsync(context.agentId, context.sessionId, {
        status,
        parentId,
        activeOnly,
      });
      const goals = tasks.filter((t) => !t.parentId);
      return {
        tasks: tasks.map(taskSummary),
        total: tasks.length,
        goals: goals.length,
      };
    },
  };
}

export function createTaskCreateTool(service: SessionTaskService): RegisteredTool {
  return {
    definition: {
      name: 'task_create',
      description:
        'Create a session task. Without parent_id creates a user-level goal. With parent_id creates a step under an existing goal (depth 1 only).',
      parameters: {
        description: {
          type: 'string',
          description: 'What needs to be done',
          required: true,
        },
        parent_id: {
          type: 'string',
          description: 'Optional goal id when creating a step',
        },
      },
    },
    handler: async (args, context) => {
      const description = String(args.description ?? '');
      const parentId = args.parent_id ? String(args.parent_id) : undefined;
      const task = await service.create(context.agentId, context.sessionId, description, parentId);
      return taskSummary(task);
    },
  };
}

export function createTaskPlanTool(service: SessionTaskService): RegisteredTool {
  return {
    definition: {
      name: 'task_plan',
      description: 'Create ordered steps for an existing goal in one call.',
      parameters: {
        goal_id: { type: 'string', description: 'Goal task id', required: true },
        steps: {
          type: 'array',
          description: 'Step descriptions in execution order',
          required: true,
          items: { type: 'string', description: 'Step description' },
          minItems: 1,
        },
      },
    },
    handler: async (args, context) => {
      const goalId = String(args.goal_id ?? '');
      const raw = args.steps;
      if (!Array.isArray(raw)) {
        throw new Error('steps must be an array of strings');
      }
      const steps = raw.map((s) => String(s));
      const created = await service.plan(context.agentId, context.sessionId, goalId, steps);
      return { steps: created.map(taskSummary), total: created.length };
    },
  };
}

export function createTaskCompleteTool(service: SessionTaskService): RegisteredTool {
  return {
    definition: {
      name: 'task_complete',
      description: 'Mark a goal or step as done. Explicitly complete the goal when the whole job is finished.',
      parameters: {
        task_id: { type: 'string', description: 'Task id', required: true },
        progress_note: { type: 'string', description: 'Optional short progress note' },
      },
    },
    handler: async (args, context) => {
      const taskId = String(args.task_id ?? '');
      const progressNote = args.progress_note ? String(args.progress_note) : undefined;
      const task = await service.complete(context.agentId, context.sessionId, taskId, progressNote);
      return taskSummary(task);
    },
  };
}

export function createTaskPauseTool(service: SessionTaskService): RegisteredTool {
  return {
    definition: {
      name: 'task_pause',
      description: 'Pause an open task (goal or step).',
      parameters: {
        task_id: { type: 'string', description: 'Task id', required: true },
        reason: { type: 'string', description: 'Optional reason' },
      },
    },
    handler: async (args, context) => {
      const taskId = String(args.task_id ?? '');
      const reason = args.reason ? String(args.reason) : undefined;
      const task = await service.pause(context.agentId, context.sessionId, taskId, reason);
      return taskSummary(task);
    },
  };
}

export function createTaskResumeTool(service: SessionTaskService): RegisteredTool {
  return {
    definition: {
      name: 'task_resume',
      description: 'Resume a paused task.',
      parameters: {
        task_id: { type: 'string', description: 'Task id', required: true },
      },
    },
    handler: async (args, context) => {
      const taskId = String(args.task_id ?? '');
      const task = await service.resume(context.agentId, context.sessionId, taskId);
      return taskSummary(task);
    },
  };
}

export function createTaskDropTool(service: SessionTaskService): RegisteredTool {
  return {
    definition: {
      name: 'task_drop',
      description: 'Drop/cancel a task. Dropping a goal also drops its open steps.',
      parameters: {
        task_id: { type: 'string', description: 'Task id', required: true },
        reason: { type: 'string', description: 'Optional reason' },
      },
    },
    handler: async (args, context) => {
      const taskId = String(args.task_id ?? '');
      const reason = args.reason ? String(args.reason) : undefined;
      const task = await service.drop(context.agentId, context.sessionId, taskId, reason);
      return taskSummary(task);
    },
  };
}

export function createTaskNoteTool(service: SessionTaskService): RegisteredTool {
  return {
    definition: {
      name: 'task_note',
      description: 'Update the progress note on a task without changing status.',
      parameters: {
        task_id: { type: 'string', description: 'Task id', required: true },
        progress_note: { type: 'string', description: 'Short progress note', required: true },
      },
    },
    handler: async (args, context) => {
      const taskId = String(args.task_id ?? '');
      const progressNote = String(args.progress_note ?? '');
      const task = await service.note(context.agentId, context.sessionId, taskId, progressNote);
      return taskSummary(task);
    },
  };
}
