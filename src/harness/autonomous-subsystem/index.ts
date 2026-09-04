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

  // Agent Context
  AgentContext,
} from './types.js';

export { SIGNAL_PRIORITY } from './types.js';

// ── Boundary ──
export { validateSubsystemSpec } from './boundary/index.js';
export type { ValidationError } from './boundary/index.js';
