/**
 * task_* 工具 — 兼容入口
 *
 * 真实实现已迁至 harness/session-tasks/tools.ts（SessionTaskService）。
 * 本文件保留旧 API 名，内部委托新工厂，避免外部 import 立刻断裂。
 *
 * @deprecated 使用 createSessionTaskTools(SessionTaskService)
 */

import type { RegisteredTool } from '../../../core/types.js';
import type { SessionTaskService } from '../../session-tasks/service.js';
import { createSessionTaskTools } from '../../session-tasks/tools.js';

/**
 * @deprecated 改用 createSessionTaskTools(service)
 */
export function createTaskTools(service: SessionTaskService): RegisteredTool[] {
  return createSessionTaskTools(service);
}
