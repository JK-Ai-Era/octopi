/**
 * Agent Loop v3 — 统一导出
 *
 * 这是 Octopi-engine 的新核心层。
 * 从旧的 AgentEngine (1833行) 提取为纯函数 + Agent 类。
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

// ── 事件适配（过渡期） ──
export { adaptEvent, adaptEventStream } from './event-adapter.js';
