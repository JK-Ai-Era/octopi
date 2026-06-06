/**
 * Harness 层统一导出
 *
 * Layer 2: 装具层
 * 通过 Core 接口挂载增强功能
 */

// ── Persona ──
export { loadPersona, composePersonas } from './persona/loader.js';

// ── Context Pipeline ──
export { DefaultContextPipeline, PersonaStage, HistoryStage, FilterStage } from './context/pipeline.js';
export type { ContextStage, StageContext } from './context/pipeline.js';
export { TaskStage } from './context/stages/task-stage.js';
export type { TaskStageConfig } from './context/stages/task-stage.js';

// ── Runner ──
export { SessionAwareRunner } from './runner.js';
export type { SessionAwareRunnerConfig } from './runner.js';

// ── Builder ──
export { AgentBuilder, createAgent } from './builder.js';

// ── 兼容层 ──
export { LegacyAgentRunner } from './compat/legacy-agent-runner.js';
export { adaptPluginHooks } from './compat/plugin-adapter.js';

// ── 安全 ──
export { CapabilityEnforcer, PluginTrustLevel } from './security/capability-enforcer.js';
export { SecurityPresets, getSecurityPolicy } from './security/policy.js';
export type { Environment } from './security/policy.js';

// ── Task System ──
export { TaskTracker, TaskManager, applyDecision } from './tasks/index.js';
export type { Task, TaskDecision, TaskDecisionInput } from './tasks/index.js';

// ── Output Quality ──
export { OutputQualityGate, createOutputQualityGate } from './quality/index.js';
export { OutputErrorClassifier, createOutputErrorClassifier } from './quality/index.js';

// ── AgentSupervisor ──
export { AgentSupervisor, startSupervisor, SupervisorEvents, EventCollector } from './supervisor/index.js';
export type {
  Planner, Reflector,
  AgentState, AgentStats,
  Plan, PlanStep, StepResult, ExecutionRecord,
  Assessment, Pattern,
  SupervisorConfig,
} from './supervisor/index.js';

// ── Config Bridge ──
export { buildFromConfig, buildFromConfigFile, resolveProviders, resolveStore, resolveSecurityConfig } from './config-bridge.js';
export type { BuiltAgent } from './config-bridge.js';
