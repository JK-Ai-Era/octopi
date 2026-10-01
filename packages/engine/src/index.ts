/**
 * @octopi-agent/engine — Harness 10 域 + Integration 库能力（可嵌入 Agent.run()）
 *
 * 不含 gateway / cli / 预构建 WebUI（见 arch/npm-package-split.md §3.3）。
 */

// ============================================================
// Core 层（Kernel 契约 re-export）
// ============================================================

export { DefaultEventBus, NoopEventBus } from '@octopi-agent/core/primitives/event-bus.js';
export { AgentEvents } from './harness/shared/events/agent-event-map.js';
export type { AgentEventMap, KnownAgentEventType, TypedAgentEvent } from './harness/shared/events/agent-event-map.js';
export type { AgentEvent, EventHandler, Disposable } from '@octopi-agent/core/primitives/event-bus.js';
export { DefaultSecurityGuard } from './harness/governance/security/default-security-guard.js';
export { BudgetPolicyEngine, DEFAULT_BUDGET } from './harness/run/budget/budget.js';
export type { BudgetPolicyConfig } from './harness/run/budget/budget.js';
export { UsageLedger } from './harness/governance/accounting/usage-ledger.js';
export type { UsageLedgerSnapshot } from './harness/governance/accounting/usage-ledger.js';
export {
  emptyTokenUsage,
  makeTokenUsage,
  nominalTotalTokens,
  reportedPromptTokens,
} from '@octopi-agent/core/types/turn.js';
export type { TokenUsage } from '@octopi-agent/core/types/turn.js';

export type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk, LLMToolDefinition } from '@octopi-agent/core/interfaces/model-provider.js';
/** 领域富模型（注册/权限/参数校验）；LLM 传输格式见 LLMToolDefinition */
export type { ToolDefinition, RegisteredTool, ToolHandler, ToolParameter, ToolSource, ToolExecutionContext } from '@octopi-agent/core/types/tools.js';
export type { ErrorStrategy, ErrorAction, OverflowAction } from '@octopi-agent/core/interfaces/error-strategy.js';
export type { SecurityAction } from '@octopi-agent/core/security-guard.js';
export type { Observer, Span, LogLevel } from '@octopi-agent/core/interfaces/observer.js';
export type { SessionStore, SessionListFilter } from '@octopi-agent/core/interfaces/session-store.js';
export type { SessionData, SessionLifecycleMeta, SessionLifecycleStatus, MemoryExtractionStatus } from './harness/session/types.js';

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

// 观测装配：注册 Integration 默认工厂，使 AgentBuilder.trace() 一行生效
import { setRunTelemetryFactory } from './harness/observability/run-telemetry.js';
import { createRunTelemetry } from './integration/observability/run-telemetry.js';
setRunTelemetryFactory(createRunTelemetry);

export { setRunTelemetryFactory, getRunTelemetryFactory } from './harness/observability/run-telemetry.js';
export type { RunTelemetry, RunTelemetryFactory } from './harness/observability/run-telemetry.js';
export { createRunTelemetry } from './integration/observability/run-telemetry.js';

export { AgentBuilder, createAgent, isSubsystemAllowed, discoverSubsystemSpecs } from './harness/agent/builder.js';
export type { AgentTraceOptions } from './harness/agent/builder.js';
export type { AgentBuildOptions, AgentBuildResult, AgentBuildCoreResult } from './harness/agent/builder.js';
export type { ChannelAdapter, ChannelMessage, ChannelReply } from './harness/extension/plugin-ecosystem/channel-types.js';
export { Agent } from './harness/run/agent/index.js';
export type { AgentOptions } from './harness/run/agent/index.js';
export type { HarnessLoopEvent, BudgetControlEvent, ControlStopMetric, PolicyUnit } from './harness/run/reliability/harness-events.js';
export { SessionAwareRunner } from './harness/run/runner.js';
export {
  DEFAULT_TOOL_ISOLATION,
  resolveToolIsolationCwd,
} from './harness/extension/execution-environment/isolation.js';
export type { ToolIsolationMode } from './harness/extension/execution-environment/isolation.js';
export { InProcessSessionLock } from './harness/run/concurrency/session-lease.js';
export type { SessionLease } from './harness/run/concurrency/session-lease.js';
export {
  SessionAclService,
  BUILTIN_SESSION_ROLES,
  computeEffectiveRights,
} from './harness/governance/session-acl/index.js';
export type {
  SessionRights,
  EffectiveSessionRights,
  SessionParticipant,
  SessionAclConfig,
  PrincipalRef,
  SessionSwitchMode,
  SwitchSessionResult,
} from './harness/governance/session-acl/types.js';
export type { SessionSwitchRecord } from './harness/session/types.js';
export type { RunAuditRecord } from './harness/activation/types.js';
export { loadPersona, composePersonas, PersonaSource } from './harness/agent/persona.js';

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

export { CapabilityEnforcer, PluginTrustLevel } from './harness/governance/security/capability-enforcer.js';

export { PluginManager } from './harness/extension/plugin-ecosystem/plugins/manager.js';
export { definePluginEntry, defineChannelPluginEntry } from './harness/extension/plugin-ecosystem/plugins/entry.js';
export type { OctopiPluginDefinition, OctopiChannelPluginDefinition } from './harness/extension/plugin-ecosystem/plugins/entry.js';
export { PluginApi } from './harness/extension/plugin-ecosystem/plugins/api.js';
export { PluginLoader } from './harness/extension/plugin-ecosystem/plugins/loader.js';
export type { LoadedPlugin, PluginLoaderConfig, PluginEntryConfig } from './harness/extension/plugin-ecosystem/plugins/loader.js';
export { CapabilityRegistry } from './harness/extension/plugin-ecosystem/plugins/capability.js';
export { validateManifest, parseManifest } from './harness/extension/plugin-ecosystem/plugins/manifest.js';
export type { PluginManifest, PluginContracts, ActivationConfig } from './harness/extension/plugin-ecosystem/plugins/manifest.js';

export { DefaultSkillManager, FileSystemSkillSource } from './harness/extension/plugin-ecosystem/skills/manager.js';
export type { SkillSource, DiscoveredSkill } from './harness/extension/plugin-ecosystem/skills/manager.js';
export type { SkillDefinition, SkillManager } from './harness/extension/plugin-ecosystem/skills/types.js';
/** 产品装配 DTO（非 Kernel）；ModelInfo/ToolPolicy 仍从 core/types 导出 */
export type { AgentPersona, ModelConfig, AgentDefinition } from './harness/shared/types/agent-definition.js';

export { DefaultToolBus } from './harness/extension/plugin-ecosystem/tools/tool-bus.js';
export { getBuiltinTools, createShellTool, createFileReadTool, createFileWriteTool, createFileListTool } from './harness/extension/plugin-ecosystem/tools/builtin.js';
export { createToolSet } from './harness/extension/plugin-ecosystem/tools/tool-set.js';
export { createSummaryPort, applyToolOutputGate, createCompactEngine, createDefaultDocumentPort, DocumentExtractError } from './harness/context/capabilities/index.js';
export type { SummaryPort, SummaryPolicy, ContentUnit, ToolSummarySupport, CompactEngine, DocumentPort, ExtractResult, ExtractSource } from './harness/context/capabilities/index.js';
export type { ToolSet, ToolSetConfig } from './harness/extension/plugin-ecosystem/tools/tool-set.js';
export { createWebSearchTool } from './harness/extension/plugin-ecosystem/tools/web-search.js';
export type { WebSearchToolOptions } from './harness/extension/plugin-ecosystem/tools/web-search.js';
export {
  createSessionHistoryPort,
  resolveHistoryAccess,
} from './harness/session/history/index.js';
export {
  createSessionHistoryTools,
  createSessionSearchTool,
  createSessionReadTool,
} from './harness/extension/plugin-ecosystem/tools/session-history.js';
export type {
  SessionHistoryPort,
  SessionHistoryQuery,
  SessionHistorySearchResult,
} from './harness/session/history/index.js';

export { buildFromConfig } from './harness/agent/config-bridge.js';
export type { BuiltAgent } from './harness/agent/config-bridge.js';

export { DefaultAgentRegistry, AgentSwarm, RoundRobinStrategy, CapabilityStrategy, PipelineStrategy, SwarmEvents, AgentProcess, spawnAgentProcess, forkAgentProcess, AgentProcessEvents } from './harness/collaboration/multi-agent/index.js';
export type { SwarmTopology, SwarmConfig, SwarmAgent, SwarmTask, OrchestrationStrategy, AgentProcessState, AgentProcessResult, AgentProcessAnnounce, AgentProcessConfig } from './harness/collaboration/multi-agent/index.js';
export type { AgentRegistry, AgentInfo, AgentQuery, AgentRelation, AgentRelationType } from './harness/collaboration/multi-agent/agent-registry-types.js';
export { AgentRegistryEvents } from './harness/collaboration/multi-agent/agent-registry-types.js';

// ============================================================
// Integration 层（engine 库能力）
// ============================================================

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

export { NoopObserver } from './integration/observability/noop-observer.js';
export { LogObserver } from './integration/observability/log-observer.js';
export { TraceLogger, TraceCollector, getTraceLogger, resetTraceLogger, TraceLevel, TRACE_LEVEL_NAMES, TRACE_EVENTS, ConsoleExporter, JsonlFileExporter, WebhookExporter, createExporter, MetricsAggregator, formatMetricsSnapshot, ObserverBridge } from './integration/observability/index.js';
export type { TraceEvent, TraceLoggerConfig, TraceCollectorConfig, TraceExporter, ExporterConfig, AnyExporterConfig, MetricsSnapshot, LatencyStats, MetricsAggregatorConfig, ObserverBridgeConfig } from './integration/observability/index.js';

export { OpenAIProvider } from './integration/providers/openai.js';
export type { OpenAIProviderConfig } from './integration/providers/openai.js';
export { AnthropicProvider } from './integration/providers/anthropic.js';
export type { AnthropicProviderConfig } from './integration/providers/anthropic.js';

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

// ============================================================
// Config（类型 + 工厂）
// ============================================================

export {
  createProviderFromConfig,
  resolveModelConfig,
  flattenModels,
  resolveListenHost,
  resolveViteHostArg,
  isLanHost,
} from './config.js';
export type {
  ModelsConfig,
  ModelProviderConfig,
  ModelCapability,
  ModelInputType,
  NormalizedHarnessConfig,
  NormalizedModelInfo,
  HarnessConfig,
  AgentConfig,
  ContextEngineConfig,
  ContextAssemblerConfig,
  ChannelConfig,
  PluginConfig,
  Defaults,
  NetworkHostConfig,
  WebSearchToolConfig,
  WebSearchProviderSlot,
} from './config.js';
export { engineConfigSchema } from './config-schema/engine.js';
export type { EngineConfig } from './config-schema/engine.js';
export { getBuiltinModelInfo, mergeWithBuiltinInfo } from './builtin-model-info.js';

// ============================================================
// Core types（Kernel 词汇表）
// ============================================================

export * from '@octopi-agent/core/types.js';
export { getTextContent, hasMediaContent } from '@octopi-agent/core/types.js';

export type { AsyncTaskStore, AsyncTaskRecord } from './harness/collaboration/orchestration/async-task-store.js';
export type {
  MemoryStore, MemoryEntry, MemoryType, MemoryQuery, MemoryStats,
  WisdomStore, WisdomEntry,
  ConceptGraphStore, ConceptNode, ConceptEdge, ConceptGraph,
  KnowledgeCatalogItem, KnowledgeCatalogProvider,
  Planner, Reflector, AgentState,
} from './harness/index.js';
export type {
  McpClient, McpManager, McpServerConfig, McpToolDefinition, McpToolResult,
} from './harness/extension/plugin-ecosystem/mcp/types.js';
export type {
  MessageChannel, ProcessMessage,
} from './harness/collaboration/multi-agent/message-channel-types.js';
export type {
  ApprovalProvider, ApprovalPolicy, ApprovalRequest, ApprovalDecision,
} from './harness/governance/human-in-the-loop/types.js';
export type {
  SandboxProvider, Workspace, IsolationLevel, SandboxConfig, SandboxResult,
} from './harness/extension/execution-environment/types.js';
export type {
  EventSource, EventSourceDescriptor, ExternalEvent,
} from './harness/activation/event-source-types.js';
