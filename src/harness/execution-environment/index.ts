/**
 * Execution Environment 领域 — 执行环境
 *
 * 职责：沙箱管理、工作区生命周期、文件操作、资源限制。
 * 契约见 ./types.ts。
 */

export { ProcessSandbox } from './sandbox.js';
export { FileWorkspace } from './workspace.js';
export type { FileWorkspaceConfig } from './workspace.js';
export type {
  IsolationLevel, SandboxConfig, ResourceLimits, ResourceUsage, SandboxResult,
  SandboxProvider, WorkspaceConfig, WorkspaceSnapshot, Workspace,
  SearchOptions, FileMatch,
} from './types.js';