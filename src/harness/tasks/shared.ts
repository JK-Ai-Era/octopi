/**
 * Shared utilities for Task Management
 *
 * 共享函数，避免代码重复。
 */

import type { TaskTracker } from './tracker.js';
import type { TaskDecision } from './types.js';

/**
 * 执行 TaskManager 的决策（更新任务状态）
 *
 * @param tracker - TaskTracker 实例
 * @param sessionId - Session ID
 * @param decision - TaskManager LLM 的决策
 */
export async function applyDecision(
  tracker: TaskTracker,
  sessionId: string,
  decision: TaskDecision,
): Promise<void> {
  for (const taskId of decision.interruptedTasks) {
    await tracker.interrupt(taskId, decision.reason);
  }
  if (decision.resumeTask) {
    await tracker.resume(decision.resumeTask);
  }
  if (decision.completesTask) {
    await tracker.complete(decision.completesTask);
  }
  if (decision.cancelTask) {
    await tracker.cancel(decision.cancelTask);
  }
  if (decision.newTask) {
    await tracker.create(sessionId, decision.newTask);
  }
}