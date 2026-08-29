/**
 * Loop Layer — 纯执行循环（Layer 0）
 *
 * 这是 Octopi 的最内层：纯函数 + Agent 类。
 * 零外部依赖，所有扩展通过 AgentLoopConfig 回调注入。
 *
 * 从 core/loop/ 提取为独立层（v0.8.0）。
 */

// ── 核心循环 ──
export { agentLoop } from './agent-loop.js';

// ── Agent 类 ──
export { Agent } from './agent.js';
export type { AgentOptions } from './agent.js';

// ── 模型调用 ──
export { callModel } from './call-model.js';

// ── 错误分类 ──
export { classifyError } from './error-classifier.js';

// ── 类型 ──
export type {
  AgentContext,
  AgentTool,
  LoopToolResult,
  AgentLoopConfig,
  ToolHooksConfig,
  TurnHooksConfig,
  AgentLoopEvent,
  LoopObserver,
  ClassifiedError,
  ErrorReason,
  BeforeToolCallContext,
  BeforeToolCallResult,
  BeforeToolCallFn,
  AfterToolCallContext,
  AfterToolCallResult,
  AfterToolCallFn,
  TurnContext,
  ShouldStopAfterTurnFn,
  OnTurnCompleteFn,
  PrepareNextTurnFn,
  OnErrorFn,
  TurnUpdate,
} from './types.js';
