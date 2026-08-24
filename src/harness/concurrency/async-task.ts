/**
 * @canonical 从 src/core/async-task.ts 重新导出
 * @deprecated 原始文件仍在 core/，此模块建立 harness 规范路径
 */
export { AsyncTask, TaskTimeoutError, TaskCancelledError, spawnTask, TaskEvents } from '../../core/async-task.js';
export type { TaskOptions, TaskExecutor } from '../../core/async-task.js';
