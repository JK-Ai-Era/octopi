/**
 * Kernel + Product ports barrel
 *
 * Kernel：ModelProvider / ErrorStrategy / SecurityGuard / RunGuard / ReliabilityHarness
 * Product（类型暂留）：ToolBus / SessionStore / Observer
 * ContextEngine 已迁 harness/context/types.ts
 */

export type {
  ModelProvider,
  LLMToolDefinition,
} from './model-provider.js';
export type {
  LLMRequest as ModelLLMRequest,
  LLMResponse as ModelLLMResponse,
  LLMMessage as ModelLLMMessage,
  LLMStreamChunk as ModelLLMStreamChunk,
  /** @deprecated Use LLMToolDefinition */
  LLMToolDefinition as ModelToolDefinition,
} from './model-provider.js';

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

export type { SessionStore, SessionListFilter } from './session-store.js';

export type {
  RunGuard,
  CheckpointContext,
  CheckpointVerdict,
  CheckpointAction,
  CheckpointMetrics,
  TurnSummary,
  RecoveryAction,
  RecoveryAttemptRecord,
  RunFailureKind,
} from './run-guard.js';

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

export type { ReliabilityHarness, ResourceBudgetLike } from './reliability.js';

export type {
  ToolBus,
} from './tool-bus.js';
