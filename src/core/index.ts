/**
 * Core 层统一导出
 *
 * Layer 1: 纯引擎 + 接口契约
 * 零实现依赖，安全内置，事件内置
 */

// ── 接口 ──
export * from './interfaces/index.js';

// ── Agent 通信 ──
export { DefaultAgentCommunicator, createAgentMessage } from './agent-communicator.js';
export type { AgentMessage, AgentMessageType, AgentMessageMetadata, AgentCommunicator } from './interfaces/agent-message.js';
export { AgentMessageEvents } from './interfaces/agent-message.js';

// ── 内置组件 ──
export { AgentEngine } from './engine.js';
export type { AgentEngineDeps, RunConfig, EngineEvent } from './engine.js';

export { DefaultEventBus, NoopEventBus, AgentEvents } from './event-bus.js';
export type { EventBus, AgentEvent as EventBusAgentEvent, EventHandler, Disposable, DefaultEventBusOptions } from './event-bus.js';

export { DefaultSecurityGuard } from './security-guard.js';
export type { SecurityGuard, SecurityCheckResult, SecurityViolation, SecurityGuardConfig } from './security-guard.js';

export { IterationBudget, DEFAULT_BUDGET } from './budget.js';
export type { IterationBudgetConfig, BudgetStatus, BudgetReport } from './budget.js';

// ── 核心原语 ──
export { AsyncTask, TaskTimeoutError, TaskCancelledError, spawnTask, TaskEvents } from './async-task.js';
export type { TaskOptions, TaskExecutor } from './async-task.js';

export { ProcessModel, ProcessEvents, spawnProcess } from './process-model.js';
export type { ProcessState, ExitReason, ExitInfo, ProcessOptions, ProcessBody, ProcessContext } from './process-model.js';

// ── 核心类型 ──
// 只从 types.ts 导出不与 interfaces 重叠的类型
export type {
  MessageRole, MessageSource, Message, ToolCall, ToolResult,
  ContentBlock, TextBlock, ImageBlock, AudioBlock, VideoBlock, FileBlock,
  AgentPersona, ModelConfig, ToolPolicy, AgentDefinition,
  SessionStatus, SessionMeta, TokenUsage, Turn,
  ToolParameter, ToolDefinition as CoreToolDefinition, ToolExecutionContext, ToolHandler, RegisteredTool,
  SkillDefinition, SkillManager,
  ChannelMessage, ChannelReply, ChannelAdapter,
  HookContext, AgentEvent, AgentEventListener, LoopEndReason, LLMStreamChunk,
  ClassifiedError, ErrorReason,
  AssembleResult, CompactResult, ContextEngineInfo, ContextEngine,
  GatewayConfig, ThinkingLevel, QueueMode,
} from './types.js';
