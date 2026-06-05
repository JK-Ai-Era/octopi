/**
 * Task System — Harness 层
 *
 * 任务管理系统，通过 ContextPipeline Stage 集成。
 */

export { TaskTracker } from './tracker.js';
export { TaskManager } from './manager.js';
export { TaskStage } from '../context/stages/task-stage.js';
export type { TaskStageConfig } from '../context/stages/task-stage.js';
export { applyDecision } from './shared.js';
export type {
  Task,
  TaskEvent,
  TaskAction,
  TaskStatus,
  TaskDecision,
  TaskDecisionInput,
  TaskTracker as ITaskTracker,
} from './types.js';
