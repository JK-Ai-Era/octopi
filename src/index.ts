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

export { DefaultEventBus, NoopEventBus } from './core/primitives/event-bus.js';
export { AgentEvents } from './harness/events/agent-event-map.js';
export type { AgentEventMap, KnownAgentEventType, TypedAgentEvent } from './harness/events/agent-event-map.js';
export type { AgentEvent, EventHandler, Disposable } from './core/primitives/event-bus.js';
export { DefaultSecurityGuard } from './harness/security/default-security-guard.js';
export { BudgetPolicyEngine, DEFAULT_BUDGET } from './harness/budget/budget.js';
export type { BudgetPolicyConfig } from './harness/budget/budget.js';
export { UsageLedger } from './harness/accounting/usage-ledger.js';
export type { UsageLedgerSnapshot } from './harness/accounting/usage-ledger.js';
export {
  emptyTokenUsage,
  makeTokenUsage,
  nominalTotalTokens,
  reportedPromptTokens,
} from './core/types/turn.js';
export type { TokenUsage } from './core/types/turn.js';

// Core 接口
export type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk, LLMToolDefinition } from './core/interfaces/model-provider.js';
/** 领域富模型（注册/权限/参数校验）；LLM 传输格式见 LLMToolDefinition */
export type { ToolDefinition, RegisteredTool, ToolHandler, ToolParameter, ToolSource, ToolExecutionContext } from './core/types/tools.js';
export type { ErrorStrategy, ErrorAction, OverflowAction } from './core/interfaces/error-strategy.js';
export type { SecurityAction } from './core/security-guard.js';
export type { Observer, Span, LogLevel } from './core/interfaces/observer.js';
export type { SessionStore, SessionListFilter } from './core/interfaces/session-store.js';
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
} from './harness/context/types.js';

// ============================================================
// Harness 层
// ============================================================

export { AgentBuilder, createAgent, isSubsystemAllowed, discoverSubsystemSpecs } from './harness/agent-building/builder.js';
export type { AgentBuildOptions, AgentBuildResult, AgentBuildCoreResult } from './harness/agent-building/builder.js';
export { Agent } from './harness/agent/index.js';
export type { AgentOptions } from './harness/agent/index.js';
export type { HarnessLoopEvent, BudgetControlEvent, ControlStopMetric, PolicyUnit } from './harness/reliability/harness-events.js';
export { SessionAwareRunner } from './harness/runner.js';
export {
  DEFAULT_TOOL_ISOLATION,
  resolveToolIsolationCwd,
} from './harness/tool-effect/isolation.js';
export type { ToolIsolationMode } from './harness/tool-effect/isolation.js';
export { InProcessSessionLock } from './harness/concurrency/session-lease.js';
export type { SessionLease } from './harness/concurrency/session-lease.js';
export {
  SessionAclService,
  BUILTIN_SESSION_ROLES,
  computeEffectiveRights,
} from './harness/session-acl/index.js';
export type {
  SessionRights,
  EffectiveSessionRights,
  SessionParticipant,
  SessionAclConfig,
  PrincipalRef,
  SessionSwitchMode,
  SwitchSessionResult,
} from './harness/session-acl/types.js';
export type { SessionSwitchRecord } from './harness/session-types.js';
export type { RunAuditRecord } from './harness/agent-runtime/types.js';
export { loadPersona, composePersonas, PersonaSource } from './harness/agent-building/persona.js';

// Context Engine
export { DefaultContextEngine } from './harness/context/default-context-engine.js';
export type { DefaultContextEngineConfig } from './harness/context/default-context-engine.js';
export { HeuristicTokenEstimator, estimateTextTokens } from './harness/context/index.js';
export { DefaultMessageSelector } from './harness/context/message-selector.js';
export { TruncateCompressor } from './harness/context/truncate-compressor.js';
export { LLMSummaryCompressor } from './harness/context/llm-summarizer.js';
export { HybridCompressor } from './harness/context/hybrid-compressor.js';
export { DefaultBudgetAllocator } from './harness/context/budget-allocator.js';
export { SmartRouter } from './harness/context/smart-router.js';
export type { SmartRouterConfig, Route, RoutingDecision } from './harness/context/smart-router.js';

// Harness 安全
export { CapabilityEnforcer, PluginTrustLevel } from './harness/security/capability-enforcer.js';

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
export type { SkillDefinition, SkillManager } from './harness/plugin-ecosystem/skills/types.js';
/** 产品装配 DTO（非 Kernel）；ModelInfo/ToolPolicy 仍从 core/types 导出 */
export type { AgentPersona, ModelConfig, AgentDefinition } from './harness/types/agent-definition.js';

// Harness Tool 系统
export { DefaultToolBus } from './harness/plugin-ecosystem/tools/tool-bus.js';
export { getBuiltinTools, createShellTool, createFileReadTool, createFileWriteTool, createFileListTool } from './harness/plugin-ecosystem/tools/builtin.js';
export { createToolSet } from './harness/plugin-ecosystem/tools/tool-set.js';
export { createSummaryPort, applyToolOutputGate, createCompactEngine } from './harness/capabilities/index.js';
export type { SummaryPort, SummaryPolicy, ContentUnit, ToolSummarySupport, CompactEngine } from './harness/capabilities/index.js';
export type { ToolSet, ToolSetConfig } from './harness/plugin-ecosystem/tools/tool-set.js';
export { createWebSearchTool } from './harness/plugin-ecosystem/tools/web-search.js';
export type { WebSearchToolOptions } from './harness/plugin-ecosystem/tools/web-search.js';
export {
  createSessionHistoryPort,
  resolveHistoryAccess,
} from './harness/session-history/index.js';
export {
  createSessionHistoryTools,
  createSessionSearchTool,
  createSessionReadTool,
} from './harness/plugin-ecosystem/tools/session-history.js';
export type {
  SessionHistoryPort,
  SessionHistoryQuery,
  SessionHistorySearchResult,
} from './harness/session-history/index.js';

// Config Bridge（配置文件 → 新架构）
export { buildFromConfig, buildFromConfigFile } from './harness/agent-building/config-bridge.js';
export type { BuiltAgent } from './harness/agent-building/config-bridge.js';

// Multi-Agent 系统
export { DefaultAgentRegistry, AgentSwarm, RoundRobinStrategy, CapabilityStrategy, PipelineStrategy, SwarmEvents, AgentProcess, spawnAgentProcess, forkAgentProcess, AgentProcessEvents } from './harness/multi-agent/index.js';
export type { SwarmTopology, SwarmConfig, SwarmAgent, SwarmTask, OrchestrationStrategy, AgentProcessState, AgentProcessResult, AgentProcessAnnounce, AgentProcessConfig } from './harness/multi-agent/index.js';
export type { AgentRegistry, AgentInfo, AgentQuery, AgentRelation, AgentRelationType } from './harness/multi-agent/agent-registry-types.js';
export { AgentRegistryEvents } from './harness/multi-agent/agent-registry-types.js';

// ============================================================
// Integration 层
// ============================================================

// 存储
export { JsonlSessionStore } from './integration/storage/jsonl.js';
export { InMemorySessionStore } from './integration/storage/memory.js';
export { SessionArchiveManager } from './integration/storage/archive-manager.js';
export type { ArchiveManagerOptions } from './integration/storage/archive-manager.js';
export {
  createSqliteSessionIndex,
  rebuildSessionIndexFromStore,
  ensureSessionIndexFresh,
} from './integration/storage/session-index.js';
export type {
  SessionIndexBackend,
  SessionIndexSink,
} from './integration/storage/session-index.js';

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

// Web Search Providers
export {
  createDuckDuckGoProvider,
  createTavilyProvider,
  createBraveProvider,
  createSerperProvider,
  createMimoProvider,
  createWebSearchProviderFromSlot,
  resolveWebSearchProviders,
  createWebSearchWithFallback,
} from './integration/web-search/index.js';
export type {
  WebSearchProvider,
  WebSearchOptions,
  WebSearchResponse,
  WebSearchResultItem,
  WebSearchConfig,
  WebSearchProviderSlotConfig,
  ResolvedWebSearchProviders,
} from './integration/web-search/index.js';

// Gateway
export { Gateway } from './integration/gateway/gateway.js';

// 协议适配
export { HttpChannelAdapter } from './integration/protocols/http.js';

// ============================================================
// Config
// ============================================================

export {
  loadConfig, toGatewayConfig, createProviderFromConfig,
  resolveModelConfig, flattenModels,
} from './config.js';
export type {
  ModelsConfig, ModelProviderConfig, ModelCapability, ModelInputType,
  NormalizedHarnessConfig, NormalizedModelInfo, HarnessConfig, AgentConfig,
  ContextEngineConfig, ContextAssemblerConfig,
  ChannelConfig, PluginConfig, Defaults,
  WebSearchToolConfig, WebSearchProviderSlot,
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
// Core types（Kernel 词汇表）
// ============================================================

export * from './core/types.js';
export { getTextContent, hasMediaContent } from './core/types.js';

// Domain 契约（已迁 harness 领域，主包仍导出常用类型）
export type { AsyncTaskStore, AsyncTaskRecord } from './harness/orchestration/async-task-store.js';
export type {
  MemoryStore, MemoryEntry, MemoryType, MemoryQuery, MemoryStats,
  WisdomStore, WisdomEntry,
  ConceptGraphStore, ConceptNode, ConceptEdge, ConceptGraph,
  KnowledgeStore, KnowledgeEntry,
  Planner, Reflector, AgentState,
} from './harness/index.js';
export type {
  McpClient, McpManager, McpServerConfig, McpToolDefinition, McpToolResult,
} from './harness/plugin-ecosystem/mcp/types.js';
export type {
  MessageChannel, ProcessMessage,
} from './harness/multi-agent/message-channel-types.js';
export type {
  ApprovalProvider, ApprovalPolicy, ApprovalRequest, ApprovalDecision,
} from './harness/human-in-the-loop/types.js';
export type {
  SandboxProvider, Workspace, IsolationLevel, SandboxConfig, SandboxResult,
} from './harness/execution-environment/types.js';
export type {
  EventSource, EventSourceDescriptor, ExternalEvent,
} from './harness/agent-runtime/event-source-types.js';
