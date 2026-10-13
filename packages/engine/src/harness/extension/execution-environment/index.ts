/**
 * Execution Environment 领域 — 执行环境
 *
 * 职责：沙箱管理、工作区生命周期、文件操作、资源限制、turn 文件 undo（L3）。
 * 契约见 ./types.ts。
 */

export { ProcessSandbox } from './sandbox.js';
export { FileWorkspace } from './workspace.js';
export type { FileWorkspaceConfig } from './workspace.js';
export {
  DEFAULT_TOOL_ISOLATION,
  resolveToolIsolationCwd,
  safeSessionDirSegment,
  looksLikeAbsoluteSessionPath,
} from './isolation.js';
export type {
  ToolIsolationMode,
  ResolveToolIsolationCwdInput,
  ResolveToolIsolationCwdResult,
} from './isolation.js';
export {
  TurnFileUndoLog,
  commitSessionFileUndo,
  discardSessionFileUndo,
  resolveSessionUndoPaths,
  resolveSessionUndoOnClose,
} from './undo-log.js';
export type {
  SessionUndoPaths,
  FileUndoEntry,
  DiscardFileEffectsResult,
  DiscardConflictReason,
} from './undo-log.js';
export { isProbablyText, reverseAgentOverwrite, merge3Lines } from './undo-merge.js';
export {
  runWithToolLimits,
  resolveToolTimeoutMs,
  ToolTimeoutError,
} from './resource-limits.js';
export type { ToolRunLimits } from './resource-limits.js';
export {
  TurnMemoryJournal,
  JournaledMemoryStore,
  createMemoryRestorer,
  discardMemoryUndo,
} from './memory-undo.js';
export type {
  MemoryUndoEntry,
  MemoryEffectRestorer,
  DiscardMemoryEffectsResult,
} from './memory-undo.js';
export type {
  IsolationLevel, SandboxConfig, ResourceLimits, ResourceUsage, SandboxResult,
  SandboxProvider, WorkspaceConfig, WorkspaceSnapshot, Workspace,
  SearchOptions, FileMatch,
} from './types.js';
