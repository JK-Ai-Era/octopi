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

export { AgentEngine } from './core/engine.js';
export { DefaultEventBus, NoopEventBus, AgentEvents } from './core/event-bus.js';
export type { AgentEvent, EventHandler, Disposable } from './core/event-bus.js';
export { DefaultSecurityGuard } from './core/security-guard.js';
export { IterationBudget } from './core/budget.js';

// Core 接口
export type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk, ToolDefinition } from './core/interfaces/model-provider.js';
export type { ToolExecutor, ExecutionContext } from './core/interfaces/tool-executor.js';
export type { ErrorStrategy, ErrorAction, OverflowAction, SecurityAction } from './core/interfaces/error-strategy.js';
export type { Observer, Span, LogLevel } from './core/interfaces/observer.js';
export type { SessionStore, SessionData } from './core/interfaces/session-store.js';

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

// Agent 通信
export { DefaultAgentCommunicator, createAgentMessage } from './core/agent-communicator.js';
export type { AgentMessage, AgentMessageType, AgentMessageMetadata, AgentCommunicator } from './core/interfaces/agent-message.js';
export { AgentMessageEvents } from './core/interfaces/agent-message.js';

// ============================================================
// Harness 层
// ============================================================

export { AgentBuilder, createAgent } from './harness/builder.js';
export { SessionAwareRunner } from './harness/runner.js';
export { loadPersona, composePersonas } from './harness/persona/loader.js';

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
export { PluginManager } from './harness/plugins/manager.js';
export { definePluginEntry, defineChannelPluginEntry } from './harness/plugins/entry.js';
export type { OctopiPluginDefinition, OctopiChannelPluginDefinition } from './harness/plugins/entry.js';
export { PluginApi } from './harness/plugins/api.js';
export { PluginLoader } from './harness/plugins/loader.js';
export type { LoadedPlugin, PluginLoaderConfig, PluginEntryConfig } from './harness/plugins/loader.js';
export { CapabilityRegistry } from './harness/plugins/capability.js';
export { validateManifest, parseManifest } from './harness/plugins/manifest.js';
export type { PluginManifest, PluginContracts, ActivationConfig } from './harness/plugins/manifest.js';

// Harness Skill 系统
export { DefaultSkillManager, FileSystemSkillSource } from './harness/skills/manager.js';
export type { SkillSource, DiscoveredSkill } from './harness/skills/manager.js';

// Harness Tool 系统
export { ToolRegistry } from './harness/tools/registry.js';
export { getBuiltinTools, createShellTool, createFileReadTool, createFileWriteTool, createFileListTool } from './harness/tools/builtin.js';

// Config Bridge（配置文件 → 新架构）
export { buildFromConfig, buildFromConfigFile } from './harness/config-bridge.js';
export type { BuiltAgent } from './harness/config-bridge.js';

// Multi-Agent 系统
export { DefaultAgentRegistry, AgentSwarm, RoundRobinStrategy, CapabilityStrategy, PipelineStrategy, SwarmEvents, AgentProcess, spawnAgentProcess, forkAgentProcess, AgentProcessEvents } from './harness/multi-agent/index.js';
export type { SwarmTopology, SwarmConfig, SwarmAgent, SwarmTask, OrchestrationStrategy, AgentProcessState, AgentProcessResult, AgentProcessAnnounce, AgentProcessConfig } from './harness/multi-agent/index.js';
export type { AgentRegistry, AgentInfo, AgentQuery, AgentRelation, AgentRelationType } from './core/interfaces/agent-registry.js';
export { AgentRegistryEvents } from './core/interfaces/agent-registry.js';

// ============================================================
// Integration 层
// ============================================================

// 存储
export { JsonlSessionStore } from './integration/storage/jsonl.js';
export { InMemorySessionStore } from './integration/storage/memory.js';

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

export { loadConfig, toGatewayConfig, createProviderFromConfig, createStoreFromConfig } from './config.js';
export { validateConfig, validateConfigOrThrow, HarnessConfigSchema } from './config-schema.js';
export type { ConfigValidationResult, ConfigValidationError } from './config-schema.js';
export { getBuiltinModelInfo, mergeWithBuiltinInfo } from './builtin-model-info.js';
export type { HarnessConfig, AgentConfig, ProviderConfig, ChannelConfig, PluginConfig, StoreConfig } from './config.js';

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
