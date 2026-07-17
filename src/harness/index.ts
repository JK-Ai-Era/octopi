/**
 * Harness 层统一导出
 *
 * Layer 2: 装具层
 * 通过 Core 接口挂载增强功能
 */

// ── Persona ──
export { loadPersona, composePersonas } from './persona/loader.js';

// ── Context Engine ──
export { DefaultContextEngine } from './context/default-context-engine.js';
export type { DefaultContextEngineConfig } from './context/default-context-engine.js';
export { HeuristicTokenEstimator, estimateTextTokens, estimateLLMMessages } from './context/token-estimator.js';
export { DefaultMessageSelector } from './context/message-selector.js';
export { TruncateCompressor } from './context/truncate-compressor.js';
export { LLMSummaryCompressor } from './context/llm-summarizer.js';
export { HybridCompressor } from './context/hybrid-compressor.js';
export { DefaultBudgetAllocator } from './context/budget-allocator.js';
export { SmartRouter } from './context/smart-router.js';
export type { SmartRouterConfig, Route, RoutingDecision } from './context/smart-router.js';

// ── Runner ──
export { SessionAwareRunner } from './runner.js';
export type { SessionAwareRunnerConfig, TaskDecisionProvider, TaskDecisionResult } from './runner.js';

// ── Builder ──
export { AgentBuilder, createAgent } from './builder.js';

// ── 安全 ──
export { CapabilityEnforcer, PluginTrustLevel } from './security/capability-enforcer.js';
export { SecurityPresets, getSecurityPolicy } from './security/policy.js';
export type { Environment } from './security/policy.js';

// ── Task System ──
export { TaskTracker, TaskManager, applyDecision, DefaultTaskDecisionProvider } from './tasks/index.js';
export type { Task, TaskDecision, TaskDecisionInput, DefaultTaskDecisionProviderConfig } from './tasks/index.js';

// ── Output Quality ──
export { OutputQualityGate, createOutputQualityGate } from './quality/index.js';
export { OutputErrorClassifier, createOutputErrorClassifier } from './quality/index.js';

// ── Strategy ──
export { RuleTaskClassifier, DefaultStrategyRouter } from './strategy/index.js';
export type { TaskClassifier, TaskClassification, TaskCategory, TaskComplexity, StrategyRouter, Strategy, StrategyKind } from './strategy/index.js';

// ── Resources ──
export { ResourceManager } from './resources/index.js';
export type { TokenBudgetConfig, ModelPricing, RateLimitConfig, TokenCheckResult, RateLimitCheckResult, ResourceStats } from './resources/index.js';

// ── Knowledge ──
export { MemoryKnowledgeStore, KnowledgeStage } from './knowledge/index.js';
export type { KnowledgeStore, KnowledgeEntry, KnowledgeType, KnowledgeStats, RetrieveOptions, KnowledgeStageConfig } from './knowledge/index.js';

// ── Reflector ──
export { LLMReflector } from './reflector/index.js';
export type { LLMReflectorConfig } from './reflector/index.js';

// ── Planner ──
export { RulePlanner, LLMPlanner, HybridPlanner, USER_MESSAGE_RULE, SECURITY_EVENT_RULE, IDLE_RULE, getDefaultRules } from './planner/index.js';
export type { Rule, RuleCondition, RuleAction, LLMPlannerConfig, HybridPlannerConfig } from './planner/index.js';

// ── Scheduler ──
export { TaskScheduler, SchedulerEvents } from './scheduler/index.js';
export type { ScheduledTask, ScheduleKind, TaskSchedulerConfig } from './scheduler/index.js';

// ── AgentSupervisor ──
export { AgentSupervisor, startSupervisor, SupervisorEvents, EventCollector, DefaultTaskSupervisor, createTaskSupervisor } from './supervisor/index.js';
export type {
  Planner, Reflector,
  AgentState, AgentStats,
  Plan, PlanStep, StepResult, ExecutionRecord,
  Assessment, Pattern,
  SupervisorConfig,
  TaskSupervisorConfig,
} from './supervisor/index.js';

// ── Config Bridge ──
export { buildFromConfig, buildFromConfigFile, resolveProviders, resolveStore, resolveSecurityConfig } from './config-bridge.js';
export type { BuiltAgent } from './config-bridge.js';

// ── Multi-Agent ──
export { DefaultAgentRegistry, AgentSwarm, RoundRobinStrategy, CapabilityStrategy, PipelineStrategy, SwarmEvents, AgentProcess, spawnAgentProcess, forkAgentProcess, AgentProcessEvents } from './multi-agent/index.js';
export type { SwarmTopology, SwarmConfig, SwarmAgent, SwarmTask, OrchestrationStrategy, AgentProcessState, AgentProcessResult, AgentProcessAnnounce, AgentProcessConfig } from './multi-agent/index.js';

// ── MCP Client ──
export { DefaultMcpManager, mcpToolToOctopiDefinition, extractMcpToolResult, splitNamespacedToolName, MCP_NAMESPACE_SEP, loadMcpServersFromDir, DEFAULT_MCP_SERVERS_DIR } from './mcp/index.js';
export type { McpClientFactory, McpManagerCallbacks } from './mcp/index.js';
