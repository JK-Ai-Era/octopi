/**
 * Core 接口统一导出
 *
 * 这些接口是框架的契约基础。
 * Core 层依赖这些接口，Harness/Integration 层实现这些接口。
 */

export type {
  ModelProvider,
} from './model-provider.js';
export type {
  LLMRequest as ModelLLMRequest,
  LLMResponse as ModelLLMResponse,
  LLMMessage as ModelLLMMessage,
  LLMStreamChunk as ModelLLMStreamChunk,
  ToolDefinition as ModelToolDefinition,
} from './model-provider.js';

export type {
  ContextEngine,
  ContextEngineInfo,
  AssembleParams,
  AssembleResult,
  IngestParams,
  CompactParams,
  CompactResult,
  AfterTurnParams,
  TokenEstimator,
  SummarizeFunction,
  MessageSelector,
  SelectResult,
  SelectOptions,
  Compressor,
  CompressParams,
  CompressResult,
  BudgetAllocator,
  BudgetAllocateParams,
  BudgetAllocateResult,
} from './context-engine.js';

export type {
  ErrorStrategy,
  ErrorAction,
  OverflowAction,
} from './error-strategy.js';

export type {
  Observer,
  Span,
  LogLevel,
  SpanStatus,
} from './observer.js';
export { Metrics } from './observer.js';

export type { SessionStore } from './session-store.js';

export type {
  EventSource,
  EventSourceDescriptor,
  ExternalEvent,
} from './event-source.js';

export type {
  TaskStore,
  TaskRecord,
  TaskStatus,
  TaskPriority,
  TaskFilter,
} from './task-store.js';

export type {
  MessageChannel,
  ProcessMessage,
  MessageHandler,
} from './message-channel.js';

export type {
  AgentRegistry,
  AgentInfo,
  AgentQuery,
  AgentRelation,
  AgentRelationType,
} from './agent-registry.js';
export { AgentRegistryEvents } from './agent-registry.js';

export type {
  TaskSupervisor,
  CheckpointContext,
  CheckpointVerdict,
  CheckpointAction,
  CheckpointMetrics,
  TurnSummary,
  RecoveryAction,
} from './task-supervisor.js';

export type {
  McpServerConfig,
  McpToolDefinition,
  McpToolResult,
  McpContentBlock,
  McpResourceDefinition,
  McpPromptDefinition,
  McpServerCapabilities,
  McpClient,
  McpManager,
} from './mcp-client.js';

export type {
  SecurityGuard,
  SecurityCheckResult,
  SecurityViolation,
  SecurityViolationType,
  SecurityAction,
  BehaviorContext,
  ToolCallRiskPolicy,
  SecurityGuardConfig,
} from './security-guard.js';

export type { ReliabilityHarness } from './reliability.js';

export type { TaskDecisionProvider, TaskDecisionResult } from './task-decision.js';

export type {
  IsolationLevel,
  SandboxConfig,
  ResourceLimits,
  ResourceUsage,
  SandboxResult,
  SandboxProvider,
  WorkspaceConfig,
  WorkspaceSnapshot,
  Workspace,
  SearchOptions,
  FileMatch,
} from './execution-environment.js';

export type {
  ApprovalLevel,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalProvider,
  ApprovalPolicy,
} from './human-in-the-loop.js';

export type {
  MemoryType,
  MemoryEntry,
  WisdomEntry,
  ConceptNode,
  ConceptEdge,
  ConceptGraph,
  MemoryQuery,
  MemoryStore,
  MemoryStats,
  WisdomStore,
  ConceptGraphStore,
} from './memory.js';
