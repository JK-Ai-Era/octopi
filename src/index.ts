/**
 * Octopi — 可嵌入的 Agent 底座框架
 *
 * 三层洋葱架构：
 * - Core (Layer 1): 纯引擎 + 接口契约
 * - Harness (Layer 2): 装具层（Persona, Plugin, Skill, Builder）
 * - Integration (Layer 3): 集成层（协议, 存储, 可观测性）
 *
 * 快速开始：
 * ```ts
 * import { AgentBuilder } from 'octopi';
 *
 * const { engine, runner } = await new AgentBuilder()
 *   .model('gpt-5.5')
 *   .persona('./my-agent')
 *   .build();
 * ```
 */

// ============================================================
// Core 层
// ============================================================

export { DefaultEventBus, NoopEventBus, AgentEvents } from './core/primitives/event-bus.js';
export type { AgentEvent, EventHandler, Disposable } from './core/primitives/event-bus.js';
export { DefaultSecurityGuard } from './harness/security/default-security-guard.js';
export { IterationBudget } from './harness/budget/budget.js';

// Core 接口
export type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk, ToolDefinition } from './core/interfaces/model-provider.js';
export type { ErrorStrategy, ErrorAction, OverflowAction } from './core/interfaces/error-strategy.js';
export type { SecurityAction } from './core/security-guard.js';
export type { Observer, Span, LogLevel } from './core/interfaces/observer.js';
export type { SessionStore } from './core/interfaces/session-store.js';
export type { SessionData, SessionLifecycleMeta, SessionLifecycleStatus, MemoryExtractionStatus } from './harness/session-types.js';

// Context Engine (new)
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
} from './core/interfaces/context-engine.js';

// ============================================================
// Harness 层
// ============================================================

export { AgentBuilder, createAgent } from './harness/agent-building/builder.js';
export { SessionAwareRunner } from './harness/runner.js';
export { loadPersona, composePersonas } from './harness/agent-building/persona.js';

// Context Engine
export { DefaultContextEngine } from './harness/context/default-context-engine.js';
export type { DefaultContextEngineConfig } from './harness/context/default-context-engine.js';
export { HeuristicTokenEstimator, estimateTextTokens } from './harness/context/token-estimator.js';
export { DefaultMessageSelector } from './harness/context/message-selector.js';
export { TruncateCompressor } from './harness/context/truncate-compressor.js';
export { LLMSummaryCompressor } from './harness/context/llm-summarizer.js';
export { HybridCompressor } from './harness/context/hybrid-compressor.js';
export { DefaultBudgetAllocator } from './harness/context/budget-allocator.js';
export { SmartRouter } from './harness/context/smart-router.js';
export type { SmartRouterConfig, Route, RoutingDecision } from './harness/context/smart-router.js';

// Harness 安全
export { CapabilityEnforcer, PluginTrustLevel } from './harness/security/capability-enforcer.js';
export { SecurityPresets, getSecurityPolicy } from './harness/security/policy.js';

// Harness Plugin 系统
export { PluginManager } from './harness/plugin-ecosystem/plugins/manager.js';
export { definePluginEntry, defineChannelPluginEntry } from './harness/plugin-ecosystem/plugins/entry.js';
export type { OctopiPluginDefinition, OctopiChannelPluginDefinition } from './harness/plugin-ecosystem/plugins/entry.js';
export { PluginApi } from './harness/plugin-ecosystem/plugins/api.js';
export { PluginLoader } from './harness/plugin-ecosystem/plugins/loader.js';
export type { LoadedPlugin, PluginLoaderConfig, PluginEntryConfig } from './harness/plugin-ecosystem/plugins/loader.js';
export { CapabilityRegistry } from './harness/plugin-ecosystem/plugins/capability.js';
export { validateManifest, parseManifest } from './harness/plugin-ecosystem/plugins/manifest.js';
export type { PluginManifest, PluginContracts, ActivationConfig } from './harness/plugin-ecosystem/plugins/manifest.js';

// Harness Skill 系统
export { DefaultSkillManager, FileSystemSkillSource } from './harness/plugin-ecosystem/skills/manager.js';
export type { SkillSource, DiscoveredSkill } from './harness/plugin-ecosystem/skills/manager.js';

// Harness Tool 系统
export { ToolRegistry } from './harness/plugin-ecosystem/tools/registry.js';
export { getBuiltinTools, createShellTool, createFileReadTool, createFileWriteTool, createFileListTool } from './harness/plugin-ecosystem/tools/builtin.js';

// Config Bridge（配置文件 → 新架构）
export { buildFromConfig, buildFromConfigFile } from './harness/agent-building/config-bridge.js';
export type { BuiltAgent } from './harness/agent-building/config-bridge.js';

// Multi-Agent 系统
export { DefaultAgentRegistry, AgentSwarm, RoundRobinStrategy, CapabilityStrategy, PipelineStrategy, SwarmEvents, AgentProcess, spawnAgentProcess, forkAgentProcess, AgentProcessEvents } from './harness/distributed-agents/multi-agent/index.js';
export type { SwarmTopology, SwarmConfig, SwarmAgent, SwarmTask, OrchestrationStrategy, AgentProcessState, AgentProcessResult, AgentProcessAnnounce, AgentProcessConfig } from './harness/distributed-agents/multi-agent/index.js';
export type { AgentRegistry, AgentInfo, AgentQuery, AgentRelation, AgentRelationType } from './core/interfaces/agent-registry.js';
export { AgentRegistryEvents } from './core/interfaces/agent-registry.js';

// ============================================================
// Integration 层
// ============================================================

// 存储
export { JsonlSessionStore } from './integration/storage/jsonl.js';
export { InMemorySessionStore } from './integration/storage/memory.js';
export { SqliteSessionStore } from './integration/storage/sqlite.js';
export type { SqliteSessionStoreOptions } from './integration/storage/sqlite.js';

// 可观测性
export { NoopObserver } from './integration/observability/noop-observer.js';
export { LogObserver } from './integration/observability/log-observer.js';
export { TraceLogger, TraceCollector, getTraceLogger, resetTraceLogger, TraceLevel, TRACE_LEVEL_NAMES, TRACE_EVENTS, ConsoleExporter, JsonlFileExporter, WebhookExporter, createExporter, MetricsAggregator, formatMetricsSnapshot, ObserverBridge } from './integration/observability/index.js';
export type { TraceEvent, TraceLoggerConfig, TraceCollectorConfig, TraceExporter, ExporterConfig, AnyExporterConfig, MetricsSnapshot, LatencyStats, MetricsAggregatorConfig, ObserverBridgeConfig } from './integration/observability/index.js';

// LLM Providers
export { OpenAIProvider } from './integration/providers/openai.js';
export type { OpenAIProviderConfig } from './integration/providers/openai.js';
export { AnthropicProvider } from './integration/providers/anthropic.js';
export type { AnthropicProviderConfig } from './integration/providers/anthropic.js';

// Gateway
export { Gateway } from './integration/gateway/gateway.js';

// 协议适配
export { HttpChannelAdapter } from './integration/protocols/http.js';

// ============================================================
// Config
// ============================================================

export {
  loadConfig, toGatewayConfig, createProviderFromConfig, createStoreFromConfig,
  resolveModelConfig, flattenModels,
} from './config.js';
export type {
  ModelsConfig, ModelProviderConfig, ModelCapability, ModelInputType,
  NormalizedHarnessConfig, NormalizedModelInfo, HarnessConfig, AgentConfig,
  ChannelConfig, PluginConfig, StoreConfig, Defaults,
} from './config.js';
export { validateConfig, validateConfigOrThrow, HarnessConfigSchema } from './config-schema.js';
export type { ConfigValidationResult, ConfigValidationError } from './config-schema.js';
export { getBuiltinModelInfo, mergeWithBuiltinInfo } from './builtin-model-info.js';


// ============================================================
// Init
// ============================================================

export { initOctopi, ensureAgentDirs, isInitialized, getOctopiHome, formatInitReport } from './init.js';

// ============================================================
// Testing
// ============================================================

export { RecordingProvider, ReplayProvider, createReplayProvider, ScenarioRunner, runScenario, formatScenarioResult, ChaosProvider, compose, extendScenario, runParameterized, formatParameterizedResults, BuiltinScenarios, notEmpty, contains, notContains, callsTool, noToolCalls, lengthBetween, matches } from './testing/index.js';
export type { RecordingEntry, RecordingConfig, ReplayConfig, Scenario, ScenarioAssertion, ScenarioResult, TurnResult, ScenarioRunnerConfig, ChaosProviderConfig, ChaosRule, ScenarioFragment, ParameterizedResult } from './testing/index.js';

// ============================================================
// Core types（全部导出）
// ============================================================

export * from './core/types.js';
export { getTextContent, hasMediaContent } from './core/types.js';
