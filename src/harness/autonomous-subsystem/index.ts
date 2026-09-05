/**
 * Autonomous Subsystem — 自主子系统
 *
 * 独立于主 Agent 循环之外，为解决特定问题而自主运行的子系统框架。
 *
 * 五维模型：Sense + Think + Act + Signal + Boundary
 *
 * @module autonomous-subsystem
 */

// ── Core Types ──
export type {
  // Signal
  SignalAction,
  Signal,
  SignalSeverity,
  SignalChannel,

  // Sense
  SenseSource,
  IsolationLevel,
  ContextField,
  SenseFilter,
  SenseConfig,
  SenseContext,

  // Think
  ThinkStrategy,
  ThinkImplementation,
  ThinkConfig,

  // Act
  ActMode,
  ActConfig,
  ActResult,

  // Signal Config
  SignalConfig,

  // Boundary
  VisibilityLevel,
  AuthorityLevel,
  SecurityLevel,
  BoundaryConfig,

  // Tool
  ToolMode,
  ToolConfig,

  // Session
  SessionMode,
  SessionScope,
  SessionConfig,

  // Lifecycle
  LifecycleConfig,

  // Input / Output
  SubsystemInput,
  SubsystemOutput,
  TaskSummary,

  // Audit
  SubsystemRun,

  // Spec
  SubsystemSpec,

  // Model Level
  ModelLevelConfig,
  ModelLevelMap,

  // Lifecycle State（子系统通用感知）
  SessionLifecycleStatus,
  ProcessExtractionStatus,

  // Agent Context
  AgentContext,
} from './types.js';

export { SIGNAL_PRIORITY } from './types.js';

// ── Boundary ──
export { validateSubsystemSpec } from './boundary/index.js';
export type { ValidationError } from './boundary/index.js';

// ── Runtime ──
export { SubsystemRuntime } from './runtime.js';
export type { SharedDeps, SubsystemRuntimeConfig } from './runtime.js';

// ── Sense ──
export { SenseEngine, MetricsStore, SessionLifecycleBridge } from './sense/index.js';
export { buildAgentInput } from './sense/input-builder.js';

// ── Think ──
export { ThinkExecutor, ModelResolver } from './think/index.js';

// ── Signal ──
export { SignalBus } from './signal/index.js';

// ── Session ──
export { SubsystemSessionManager, parseTTL } from './session/index.js';

// ── Audit ──
export { AuditWriter, AuditReader } from './audit/index.js';

// ── Loader ──
export { SubsystemLoader } from './loader.js';
export type { SubsystemLoaderConfig, LoadResult } from './loader.js';
