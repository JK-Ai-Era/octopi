/**
 * orchestration 领域统一导出（experimental）
 *
 * 确定性多步骤作业：workflow / scheduler / planner / strategy / quality / reflector。
 * 默认不进主路径；经 package 子路径 `octopi/harness/orchestration` 访问。
 *
 * 与 Session.tasks 的唯一合法耦合：长流水线启动时经 SessionTaskService.create
 * 登记一条对用户可见的任务；结束时 complete/drop。禁止反向 import。
 */

export * from './workflow/index.js';
export * from './scheduler/index.js';
export * from './planner/index.js';
export * from './strategy/index.js';
export * from './quality/index.js';
export * from './reflector/index.js';
export { AsyncTask, TaskTimeoutError, TaskCancelledError, spawnTask, TaskEvents } from './async-task.js';
export type { TaskOptions, TaskExecutor } from './async-task.js';
export type { AsyncTaskStore, AsyncTaskRecord, AsyncTaskStatus, AsyncTaskPriority, AsyncTaskFilter } from './async-task-store.js';
export type {
  Planner, Reflector, AgentState, AgentStats, Plan, PlanStep,
  StepResult, ExecutionRecord, Assessment, Pattern,
} from './cognitive-loop.js';
