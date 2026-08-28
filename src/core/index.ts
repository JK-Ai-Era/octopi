/**
 * Core 层统一导出
 *
 * Layer 1: 接口契约 + 纯引擎原语
 *
 * 设计原则：
 * - Core 只定义接口和纯机制，不包含策略实现
 * - 策略实现（DefaultSecurityGuard 等）在 Harness 层
 * - 外层可替换所有 Core 组件
 */

// ── 接口契约 ──
export * from './interfaces/index.js';

// ── EventBus ──
// @deprecated EventBus 是旧的 emit-based 事件系统。
// 新架构使用 yield-based AgentLoopEvent（core/loop/types.ts）。
// 远期计划：EventBus 实现迁移到 Harness 层，Core 只保留接口。
export { DefaultEventBus, NoopEventBus, ThrottledEventBus, AgentEvents } from './event-bus.js';
export type { EventBus, AgentEvent, AgentEvent as EventBusAgentEvent, EventHandler, Disposable, DefaultEventBusOptions, ThrottleConfig } from './event-bus.js';

// ── 安全守卫 ──
// 接口 + 验证函数在 Core，DefaultSecurityGuard 实现在 Harness
export { isValidSecurityGuard, severityToAction } from './security-guard.js';
export type { SecurityGuard, SecurityCheckResult, SecurityViolation, SecurityViolationType, SecurityAction, BehaviorContext, SecurityGuardConfig } from './security-guard.js';
// 向后兼容 re-export（实际实现在 harness/security/）
export { DefaultSecurityGuard } from '../harness/security/default-security-guard.js';

// ── 资源约束 ──
// @deprecated IterationBudget 实现将迁移到 Harness 层
export { IterationBudget, DEFAULT_BUDGET } from './budget.js';
export type { IterationBudgetConfig, BudgetStatus, BudgetReport } from './budget.js';

// ── 异步任务原语 ──
export { AsyncTask, TaskTimeoutError, TaskCancelledError, spawnTask, TaskEvents } from './async-task.js';
export type { TaskOptions, TaskExecutor } from './async-task.js';

// ── 进程模型 ──
export { ProcessModel, ProcessEvents, spawnProcess } from './process-model.js';
export type { ProcessState, ExitReason, ExitInfo, ProcessOptions, ProcessBody, ProcessContext } from './process-model.js';

// ── 状态机 ──
export { StateMachine, createSessionStateMachine } from './state-machine.js';
export type { StateTransition, StateMachineConfig } from './state-machine.js';

// ── 核心类型（从 types/ 子模块 re-export） ──
export type {
  // 消息系统
  MessageRole, MessageSource, Message, ToolCall, ToolResult,
  ContentBlock, TextBlock, ImageBlock, AudioBlock, VideoBlock, FileBlock,
  // Agent 定义
  AgentPersona, ModelConfig, ToolPolicy, AgentDefinition,
  // Session
  SessionStatus, SessionMeta,
  // Turn
  TokenUsage, Turn,
  // 工具系统
  ToolParameter, ToolDefinition as CoreToolDefinition, ToolExecutionContext, ToolHandler, RegisteredTool,
  // Skill 系统
  SkillDefinition, SkillManager,
  // 以下类型已迁移到正确层，此处为向后兼容 re-export
  // @layer integration: ChannelAdapter, ChannelMessage, ChannelReply, GatewayConfig
  // @layer harness: HookContext, QueueMode, ThinkingLevel
  ChannelMessage, ChannelReply, ChannelAdapter,
  HookContext, QueueMode, ThinkingLevel,
  GatewayConfig,
  // Agent Event（@layer harness）
  AgentEventDetail, AgentEventListener, LoopEndReason, LLMStreamChunk,
  // Error 分类
  ClassifiedError, ErrorReason,
  // Context Engine
  AssembleResult, CompactResult, ContextEngineInfo, ContextEngine,
} from './types.js';

// ── Agent Loop v3（新核心循环） ──
export { agentLoop, Agent, callModel, classifyError } from './loop/index.js';
export type {
  AgentOptions, AgentContext, AgentTool, LoopToolResult,
  AgentLoopConfig, AgentLoopEvent, LoopObserver,
  ClassifiedError as LoopClassifiedError,
} from './loop/index.js';
