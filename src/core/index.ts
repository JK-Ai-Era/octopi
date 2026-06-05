/**
 * Core 层统一导出
 *
 * Layer 1: 纯引擎 + 接口契约
 * 零实现依赖，安全内置，事件内置
 */

// ── 接口 ──
export * from './interfaces/index.js';

// ── 内置组件 ──
export { AgentEngine } from './engine.js';
export type { AgentEngineDeps, RunConfig, EngineEvent } from './engine.js';

export { DefaultEventBus, NoopEventBus, AgentEvents } from './event-bus.js';
export type { EventBus, AgentEvent as EventBusAgentEvent, EventHandler, Disposable } from './event-bus.js';

export { DefaultSecurityGuard } from './security-guard.js';
export type { SecurityGuard, SecurityCheckResult, SecurityViolation, SecurityGuardConfig } from './security-guard.js';

export { IterationBudget, DEFAULT_BUDGET } from './budget.js';
export type { IterationBudgetConfig, BudgetStatus, BudgetReport } from './budget.js';

// ── 核心类型 ──
// 只从 types.ts 导出不与 interfaces 重叠的类型
export type {
  MessageRole, MessageSource, Message, ToolCall, ToolResult,
  AgentPersona, ModelConfig, ToolPolicy, AgentDefinition,
  SessionStatus, SessionMeta, TokenUsage, Turn,
  ToolParameter, ToolDefinition as CoreToolDefinition, ToolExecutionContext, ToolHandler, RegisteredTool,
  SkillDefinition, SkillManager,
  LLMRequest as LegacyLLMRequest, LLMResponse as LegacyLLMResponse, LLMProvider,
  ChannelMessage, ChannelReply, ChannelAdapter,
  HookContext, AgentEvent, AgentEventListener, LoopEndReason, LLMStreamChunk,
  ClassifiedError, ErrorReason,
  AssembleResult, CompactResult, ContextEngineInfo, ContextEngine,
  GatewayConfig, LLMMessage as CoreLLMMessage, MessageConverter,
  AgentLoopConfig, RetryConfig, ThinkingLevel, QueueMode,
} from './types.js';
