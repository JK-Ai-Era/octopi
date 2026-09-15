/**
 * Loop Layer — 纯执行循环（Layer 0）
 *
 * 这是 Octopi 的最内层：agentLoop 纯函数 + 协议类型。
 * 零外部依赖，所有扩展通过 AgentLoopConfig 回调注入。
 *
 * 可运行的 Agent 门面在 `harness/agent/`（run() = reliability 包装）。
 * 直接调用 agentLoop 仅用于单测或自定义包装层。
 */

// ── 核心循环 ──
export { agentLoop } from './agent-loop.js';

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
