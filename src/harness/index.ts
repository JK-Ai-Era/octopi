/**
 * Harness 层统一导出（Layer 2）
 *
 * 11 个自包含领域，每个领域通过 index.ts 导出。
 */

// ── Agent Building ──
export { AgentBuilder, createAgent } from './agent-building/builder.js';
export { loadPersona, composePersonas } from './agent-building/persona.js';
export { buildFromConfig, buildFromConfigFile, resolveProviders, resolveStore, resolveSecurityConfig, resolveContextEngine, resolveSupervisor } from './agent-building/config-bridge.js';
export type { BuiltAgent } from './agent-building/config-bridge.js';

// ── Context Management ──
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

// ── Security ──
export { CapabilityEnforcer, PluginTrustLevel } from './security/capability-enforcer.js';
export { SecurityPresets, getSecurityPolicy } from './security/policy.js';
export type { Environment } from './security/policy.js';

// ── Reliability ──
export { runAgentWithReliability, DEFAULT_RELIABILITY_CONFIG } from './reliability/index.js';
export type { ReliabilityConfig, ConcreteReliabilityHarness } from './reliability/index.js';
export type { ReliabilityHarness } from '../core/interfaces/reliability.js';
export { CircuitBreaker } from './reliability/circuit-breaker.js';
export { wrapProviderWithCircuitBreaker } from './reliability/provider-wrapper.js';

// ── Plugin Ecosystem ──
export { PluginManager } from './plugin-ecosystem/plugins/manager.js';
export { definePluginEntry, defineChannelPluginEntry } from './plugin-ecosystem/plugins/entry.js';
export type { OctopiPluginDefinition, OctopiChannelPluginDefinition } from './plugin-ecosystem/plugins/entry.js';
export { PluginApi } from './plugin-ecosystem/plugins/api.js';
export { PluginLoader } from './plugin-ecosystem/plugins/loader.js';
export type { LoadedPlugin, PluginLoaderConfig, PluginEntryConfig } from './plugin-ecosystem/plugins/loader.js';
export { CapabilityRegistry } from './plugin-ecosystem/plugins/capability.js';
export { validateManifest, parseManifest } from './plugin-ecosystem/plugins/manifest.js';
export type { PluginManifest, PluginContracts, ActivationConfig } from './plugin-ecosystem/plugins/manifest.js';
export { ToolRegistry } from './plugin-ecosystem/tools/registry.js';
export { getBuiltinTools, createShellTool, createFileReadTool, createFileWriteTool, createFileListTool } from './plugin-ecosystem/tools/builtin.js';
export { DefaultSkillManager, FileSystemSkillSource } from './plugin-ecosystem/skills/manager.js';
export type { SkillSource, DiscoveredSkill } from './plugin-ecosystem/skills/manager.js';
export { DefaultMcpManager, mcpToolToOctopiDefinition, extractMcpToolResult, splitNamespacedToolName, MCP_NAMESPACE_SEP, loadMcpServersFromDir, DEFAULT_MCP_SERVERS_DIR } from './plugin-ecosystem/mcp/index.js';
export type { McpClientFactory, McpManagerCallbacks } from './plugin-ecosystem/mcp/index.js';

// ── Distributed Agents ──
export { DefaultAgentRegistry, AgentSwarm, RoundRobinStrategy, CapabilityStrategy, PipelineStrategy, SwarmEvents, AgentProcess, spawnAgentProcess, forkAgentProcess, AgentProcessEvents } from './distributed-agents/index.js';
export type { SwarmTopology, SwarmConfig, SwarmAgent, SwarmTask, OrchestrationStrategy, AgentProcessState, AgentProcessResult, AgentProcessAnnounce, AgentProcessConfig } from './distributed-agents/index.js';

// ── Task System ──
export { TaskTracker, TaskManager, applyDecision, DefaultTaskDecisionProvider } from './task-system/tasks/index.js';
export type { Task, TaskDecision, TaskDecisionInput, DefaultTaskDecisionProviderConfig } from './task-system/tasks/index.js';
export { RulePlanner, LLMPlanner, HybridPlanner, USER_MESSAGE_RULE, SECURITY_EVENT_RULE, IDLE_RULE, getDefaultRules } from './task-system/planner/index.js';
export type { Rule, RuleCondition, RuleAction, LLMPlannerConfig, HybridPlannerConfig } from './task-system/planner/index.js';
export { TaskScheduler, SchedulerEvents } from './task-system/scheduler/index.js';
export type { ScheduledTask, ScheduleKind, TaskSchedulerConfig } from './task-system/scheduler/index.js';
export { OutputQualityGate, createOutputQualityGate, OutputErrorClassifier, createOutputErrorClassifier } from './task-system/quality/index.js';
export { RuleTaskClassifier, DefaultStrategyRouter } from './task-system/strategy/index.js';
export type { TaskClassifier, TaskClassification, TaskCategory, TaskComplexity, StrategyRouter, Strategy, StrategyKind } from './task-system/strategy/index.js';
export { LLMReflector } from './task-system/reflector/index.js';
export type { LLMReflectorConfig } from './task-system/reflector/index.js';
export { MemoryKnowledgeStore, KnowledgeStage } from './task-system/knowledge/index.js';
export type { KnowledgeStore, KnowledgeEntry, KnowledgeType, KnowledgeStats, RetrieveOptions, KnowledgeStageConfig } from './task-system/knowledge/index.js';
export { AgentSupervisor, startSupervisor, SupervisorEvents, EventCollector, DefaultTaskSupervisor, createTaskSupervisor } from './task-system/supervisor/index.js';
export type { Planner, Reflector, AgentState, AgentStats, Plan, PlanStep, StepResult, ExecutionRecord, Assessment, Pattern, SupervisorConfig, TaskSupervisorConfig } from './task-system/supervisor/index.js';

// ── Concurrency ──
// (exported from concurrency/index.ts)

// ── Resources ──
export { ResourceManager } from './resources/index.js';
export type { TokenBudgetConfig, ModelPricing, RateLimitConfig, TokenCheckResult, RateLimitCheckResult, ResourceStats } from './resources/index.js';

// ── Runner ──
export { SessionAwareRunner } from './runner.js';
export type { SessionAwareRunnerConfig } from './runner.js';

// ── Config Bridge ──
// (exported from agent-building above)

// ── Loop re-export ──
export { agentLoop, Agent, callModel, classifyError } from '../loop/index.js';
export type { AgentOptions, AgentContext, AgentTool, LoopToolResult, AgentLoopConfig, AgentLoopEvent, LoopObserver, ClassifiedError as LoopClassifiedError } from '../loop/index.js';

// ── Harness 层类型 ──
export * from './types/index.js';

// ── Concurrency re-exports ──
export * from './concurrency/tool-loop-detection.js';
export * from './concurrency/state-machine.js';
export * from './concurrency/async-task.js';
export * from './budget/index.js';
export * from './process/index.js';
