/**
 * Execution Environment 领域 — 执行环境
 *
 * 职责：沙箱管理、工作区生命周期、文件操作、资源限制。
 *
 * 依赖：
 * - Core: interfaces/execution-environment
 */

export { ProcessSandbox } from './sandbox.js';
export { FileWorkspace } from './workspace.js';
export type { FileWorkspaceConfig } from './workspace.js';
