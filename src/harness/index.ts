/**
 * Harness 层统一导出（Layer 2）
 *
 * 15 个自包含领域，每个领域通过 index.ts 导出。
 */

// ── Accounting（用量账本；arch/budget-redesign.md P1） ──
export { UsageLedger, SessionLedger } from './governance/accounting/index.js';
export type { UsageLedgerSnapshot, SessionLedgerSnapshot } from './governance/accounting/index.js';

// ── Tool 系统 ──
export { createToolSet } from './extension/plugin-ecosystem/tools/tool-set.js';
export type { ToolSet, ToolSetConfig } from './extension/plugin-ecosystem/tools/tool-set.js';
export { createWebSearchTool } from './extension/plugin-ecosystem/tools/web-search.js';
export type { WebSearchToolOptions } from './extension/plugin-ecosystem/tools/web-search.js';
export {
  createSessionHistoryPort,
  resolveHistoryAccess,
} from './session/history/index.js';
export {
  createSessionHistoryTools,
  createSessionSearchTool,
  createSessionReadTool,
} from './extension/plugin-ecosystem/tools/session-history.js';
export type {
  SessionHistoryPort,
  SessionHistoryQuery,
  SessionHistorySearchResult,
  SessionHistoryOptions,
} from './session/history/index.js';

// ── Capabilities（公用能力；横切，不计入业务领域口径） ──
export {
  createSummaryPort,
  applyToolOutputGate,
  createDefaultSummaryPolicies,
  resolveSummaryModel,
  getToolSummaryBinding,
  createCompactEngine,
  createMemorySummaryCache,
} from './context/capabilities/index.js';
export type {
  ContentUnit,
  ContentKind,
  ContentChannel,
  SummaryPort,
  SummaryPolicy,
  SummaryResult,
  ToolSummaryBinding,
  ToolSummarySupport,
  CreateSummaryPortOptions,
  CompactEngine,
  CompactOptions,
  CompactOutcome,
} from './context/capabilities/index.js';

// ── Agent Building ──
export { AgentBuilder, createAgent, isSubsystemAllowed, discoverSubsystemSpecs } from './agent/builder.js';
export type { AgentBuildOptions, AgentBuildResult, AgentBuildCoreResult } from './agent/builder.js';
export { loadPersona, composePersonas, PersonaSource } from './agent/persona.js';
export { buildFromConfig, buildFromConfigFile, resolveProviders, resolveSecurityConfig, resolveContextEngine, resolveRunGuard } from './agent/config-bridge.js';
export type { BuiltAgent } from './agent/config-bridge.js';

// ── Context Management ──
export { DefaultContextEngine } from './context/default-context-engine.js';
export type { DefaultContextEngineConfig } from './context/default-context-engine.js';
export { HeuristicTokenEstimator, estimateTextTokens, estimateLLMMessages } from './context/index.js';
export {
  JSON_CHARS_PER_TOKEN,
  TOOL_RESULT_CHARS_PER_TOKEN,
  CHARS_PER_TOKEN,
} from './context/index.js';
export { DefaultMessageSelector } from './context/message-selector.js';
export { TruncateCompressor } from './context/truncate-compressor.js';
export { LLMSummaryCompressor } from './context/llm-summarizer.js';
export { HybridCompressor } from './context/hybrid-compressor.js';
export { DefaultBudgetAllocator } from './context/budget-allocator.js';
export { SmartRouter } from './context/smart-router.js';
export type { SmartRouterConfig, Route, RoutingDecision } from './context/smart-router.js';
export {
  LAYER_ORDER,
  LAYER_PRIORITY,
  LAYER_DEFAULT_SHARE,
  extractLayerQuery,
  hasLayerText,
  DefaultContextAssembler,
  truncateTextToTokens,
  ALL_LAYER_IDS,
  buildContextLayersSnapshot,
  deriveLayerStatus,
  emptyContextLayersSnapshot,
  probeContextLayerHealth,
  probeAgentHomeHealth,
  PersonaLayer,
  SkillLayer,
  RuntimeLayer,
  KnowledgeLayer,
  MemoryLayer,
  CognitionLayer,
  WisdomLayer,
  createDefaultLayers,
  createProviderSummarize,
  pickSummarizeProvider,
  createDefaultSystemPromptAssembler,
} from './context/index.js';
export type {
  ContextLayerId,
  LayerAssembleContext,
  LayerContent,
  ContextLayer,
  LayerManifestEntry,
  AssembleManifest,
  SystemAssembleResult,
  ContextAssembler,
  ContextAssembleParams,
  DefaultContextAssemblerConfig,
  CreateDefaultLayersOptions,
  CreateProviderSummarizeOptions,
  SystemPromptAssembleInput,
  SystemPromptAssembleOutput,
  ContextLayersSnapshot,
  LayerRuntimeView,
  LayerUiStatus,
  ContextLayerHealth,
  ContextLayerHealthEntry,
  ProbeContextHealthDeps,
  ContextCompactReason,
  ContextCompactEvent,
  ContextEmitFn,
  ContextCompactSnapshot,
} from './context/index.js';

// ── Security ──
export { CapabilityEnforcer, PluginTrustLevel } from './governance/security/capability-enforcer.js';

// ── Reliability ──
export { runAgentWithReliability, DEFAULT_RELIABILITY_CONFIG } from './run/reliability/index.js';
export type { ReliabilityConfig, ConcreteReliabilityHarness } from './run/reliability/index.js';
export type { ReliabilityHarness, ResourceBudgetLike } from '../core/interfaces/reliability.js';
export { RunMetricsCollector } from './run/reliability/run-metrics-collector.js';
export { CircuitBreaker } from './run/reliability/circuit-breaker.js';
export { wrapProviderWithCircuitBreaker } from './run/reliability/provider-wrapper.js';
export { FallbackProvider } from './run/reliability/fallback-provider.js';

// ── Plugin Ecosystem ──
export { PluginManager } from './extension/plugin-ecosystem/plugins/manager.js';
export { definePluginEntry, defineChannelPluginEntry } from './extension/plugin-ecosystem/plugins/entry.js';
export type { OctopiPluginDefinition, OctopiChannelPluginDefinition } from './extension/plugin-ecosystem/plugins/entry.js';
export { PluginApi } from './extension/plugin-ecosystem/plugins/api.js';
export { PluginLoader } from './extension/plugin-ecosystem/plugins/loader.js';
export type { LoadedPlugin, PluginLoaderConfig, PluginEntryConfig } from './extension/plugin-ecosystem/plugins/loader.js';
export { CapabilityRegistry } from './extension/plugin-ecosystem/plugins/capability.js';
export { validateManifest, parseManifest } from './extension/plugin-ecosystem/plugins/manifest.js';
export type { PluginManifest, PluginContracts, ActivationConfig } from './extension/plugin-ecosystem/plugins/manifest.js';
export { DefaultToolBus } from './extension/plugin-ecosystem/tools/tool-bus.js';
export { getBuiltinTools, createShellTool, createFileReadTool, createFileWriteTool, createFileListTool } from './extension/plugin-ecosystem/tools/builtin.js';
export { DefaultSkillManager, FileSystemSkillSource } from './extension/plugin-ecosystem/skills/manager.js';
export type { SkillSource, DiscoveredSkill } from './extension/plugin-ecosystem/skills/manager.js';
export type { SkillDefinition, SkillManager } from './extension/plugin-ecosystem/skills/types.js';
export { IssueRegistry } from './observability/diagnostics/index.js';
export type {
  IssueDomain,
  IssueSeverity,
  IssueStatus,
  SystemIssue,
} from './observability/diagnostics/index.js';
export {
  CommandRouter,
  parseCommand,
  normalizeCommandName,
  createBuiltinCommands,
  createClientCatalogCommand,
  skillCommandsFromManager,
  loadUserCommandDefs,
  pluginCommandsFromManager,
} from './extension/plugin-ecosystem/commands/index.js';
export type {
  CommandCatalogItem,
  CommandConflict,
  CommandDefinition,
  CommandResult,
  SessionOp,
} from './extension/plugin-ecosystem/commands/index.js';
export type { AgentPersona, ModelConfig, AgentDefinition } from './shared/types/agent-definition.js';
export { DefaultMcpManager, mcpToolToOctopiDefinition, extractMcpToolResult, splitNamespacedToolName, MCP_NAMESPACE_SEP, loadMcpServersFromDir, DEFAULT_MCP_SERVERS_DIR } from './extension/plugin-ecosystem/mcp/index.js';
export type { McpClientFactory, McpManagerCallbacks, McpClient, McpManager, McpServerConfig } from './extension/plugin-ecosystem/mcp/index.js';
export type { WebSearchProvider, WebSearchOptions, WebSearchResponse } from './extension/plugin-ecosystem/tools/web-search-types.js';

// ── Multi-Agent ──
export { DefaultAgentRegistry, AgentSwarm, RoundRobinStrategy, CapabilityStrategy, PipelineStrategy, SwarmEvents, AgentProcess, spawnAgentProcess, forkAgentProcess, AgentProcessEvents } from './collaboration/multi-agent/index.js';
export type { SwarmTopology, SwarmConfig, SwarmAgent, SwarmTask, OrchestrationStrategy, AgentProcessState, AgentProcessResult, AgentProcessAnnounce, AgentProcessConfig, AgentRegistry, AgentInfo, AgentQuery, AgentRelation } from './collaboration/multi-agent/index.js';
export { AgentRegistryEvents } from './collaboration/multi-agent/agent-registry-types.js';

// ── HITL / Execution Environment ──
export type { ApprovalLevel, ApprovalProvider, ApprovalPolicy, ApprovalRequest, ApprovalDecision } from './governance/human-in-the-loop/types.js';
export type { MessageChannel, ProcessMessage, MessageHandler } from './collaboration/multi-agent/message-channel-types.js';
export type { SandboxProvider, Workspace, SandboxResult, IsolationLevel } from './extension/execution-environment/types.js';
export type { EventSource, EventSourceDescriptor, ExternalEvent } from './activation/event-source-types.js';

// ── Autonomous Subsystem ──
export { SubsystemRuntime } from './collaboration/autonomous-subsystem/runtime.js';
export type { SharedDeps, SubsystemRuntimeConfig } from './collaboration/autonomous-subsystem/runtime.js';
export { SubsystemLoader } from './collaboration/autonomous-subsystem/loader.js';
export type { SubsystemLoaderConfig, LoadResult } from './collaboration/autonomous-subsystem/loader.js';
export { SenseEngine, MetricsStore } from './collaboration/autonomous-subsystem/sense/index.js';
export { ThinkExecutor, ModelResolver } from './collaboration/autonomous-subsystem/think/index.js';
export {
  createSubsystemLLMPort,
  DEP_LLM_PORT,
  DEP_SUBSYSTEM_PROMPT,
  DEP_RESOLVED_MODEL,
  DEP_RESOLVED_MODELS,
} from './collaboration/autonomous-subsystem/think/index.js';
export type {
  SubsystemLLMPort,
  SubsystemLLMPortChatRequest,
} from './collaboration/autonomous-subsystem/think/index.js';
export { SignalBus } from './collaboration/autonomous-subsystem/signal/index.js';
export { SubsystemSessionManager, parseTTL } from './collaboration/autonomous-subsystem/session/index.js';
export { AuditWriter, AuditReader } from './collaboration/autonomous-subsystem/audit/index.js';
export { validateSubsystemSpec } from './collaboration/autonomous-subsystem/boundary/index.js';

// ── Session Tasks（会话任务，Session 聚合）──
export { SessionTaskService, renderSessionTasksInjection, createSessionTaskTools } from './session/tasks/index.js';
export type { SessionTask, SessionTaskStatus, SessionTaskListFilter } from './session/tasks/index.js';

// ── Run Guard（过程监督）──
// AgentSupervisor 已归档（arch/agent-runtime.md §10）
export { DefaultRunGuard, createRunGuard } from './run/run-guard/index.js';
export type { RunGuardConfig } from './run/run-guard/index.js';

// ── Agent Runtime（激活宿主；arch/agent-runtime.md）──
export {
  AgentRuntime,
  ExplicitRouter,
  SessionRunnerDispatcher,
  ScheduleSource,
  EscalateBridge,
  AgentSignalSource,
  emitEscalate,
  emitAgentSignal,
  RuntimeEvents as AgentRuntimeEvents,
} from './activation/index.js';
export type {
  AgentRuntimeConfig,
  Trigger,
  TriggerType,
  TriggerPayload,
  TriggerSource,
  RunRequest,
  RunDispatcher,
  RuntimeAgent,
  DispatchResult,
  RuntimeEvent,
  ScheduleJob,
  EscalateBridgeConfig,
  AgentSignal,
} from './activation/index.js';

// ── Knowledge（Tier 0 catalog；见 arch/knowledge-layer.md）──
export type { KnowledgeCatalogItem, KnowledgeCatalogProvider } from './knowledge/catalog-index.js';
export {
  KnowledgeDatabase,
  KnowledgeSourceStore,
  KnowledgeIndexStore,
  KnowledgeIngest,
  KnowledgeRetriever,
  GroundingAssembler,
  formatKnowledgeGroundingMessage,
  resolveGroundingQuery,
  wrapUntrustedKnowledgeBlock,
  isKnowledgeGroundingMessage,
  stripKnowledgeGrounding,
  KnowledgeHitLog,
  KnowledgePurger,
  FormatAdapterRegistry,
  resolveKnowledgePaths,
  generateKnowledgeDescription,
  heuristicDescription,
  scanSecretShapes,
  hashContent,
  textAdapter,
  markdownAdapter,
  codeAdapter,
} from './knowledge/index.js';
export type {
  KnowledgeDatabaseOptions,
  KnowledgePaths,
  KnowledgeDescribePort,
  KnowledgeDescribeOptions,
  KnowledgeDescribeResult,
  KnowledgeSource,
  KnowledgeSourceInput,
  KnowledgeSourcePatch,
  KnowledgeSourceKind,
  KnowledgeSourceStatus,
  KnowledgeSourceSync,
  KnowledgeSourceError,
  KnowledgeScopeRef,
  KnowledgeScopeLevel,
  KnowledgeIngestOptions,
  IngestProgressEvent,
  IngestJobKind,
  HybridSearchOptions,
  HybridSearchResult,
  AutoGroundDecision,
  GroundingMode,
  KnowledgeRetrieverOptions,
  KnowledgeHitRecord,
  KnowledgeHitStats,
  PromotionCandidate,
  PurgeResult,
  FormatAdapter,
  KnowledgeChunkDraft,
  IndexedFileRecord,
  ChunkHit,
} from './knowledge/index.js';

// ── Orchestration（experimental，默认不进主路径；见 octopi/harness/collaboration/orchestration）──

// ── Concurrency ──
// (exported from concurrency/index.ts)

// ── Memory ──
export { InMemoryMemoryStore, InMemoryConceptGraph, AgentDatabase, SqliteMemoryStore, SqliteWisdomStore, SqliteConceptGraph, createEmbeddingProvider } from './memory/index.js';
export type { AgentDatabaseOptions, SqliteMemoryStoreOptions, SqliteConceptGraphOptions, EmbeddingProvider, EmbeddingConfig } from './memory/index.js';
export {
  createEmbeddingProviderFromModels,
  resolveEmbeddingRuntime,
  isEmbeddingEnabled,
  tokenizeKeywordQuery,
  scoreKeywordFields,
} from './memory/index.js';

// ── Memory 领域类型 ──
export type { MemoryType, MemoryEntry, MemoryQuery, MemoryStats, MemoryStore } from './memory/types.js';
export type { WisdomEntry, WisdomStore } from './memory/types.js';
export type { ConceptNode, ConceptEdge, ConceptGraph, ConceptGraphStore } from './memory/types.js';
export type {
  Planner, Reflector, AgentState, AgentStats, Plan, PlanStep,
  StepResult, ExecutionRecord, Assessment, Pattern,
} from './collaboration/orchestration/cognitive-loop.js';

// ── Session 类型 ──
export type { SessionData, SessionLifecycleMeta, SessionLifecycleStatus, MemoryExtractionStatus } from './session/types.js';

// ── Runner ──
export { SessionAwareRunner } from './run/runner.js';
export type { SessionAwareRunnerConfig } from './run/runner.js';

// ── Tool effect isolation (I5) ──
export {
  DEFAULT_TOOL_ISOLATION,
  resolveToolIsolationCwd,
} from './extension/execution-environment/isolation.js';
export type {
  ToolIsolationMode,
  ResolveToolIsolationCwdInput,
  ResolveToolIsolationCwdResult,
} from './extension/execution-environment/isolation.js';

// ── Session Lease (E2/E7) ──
export { InProcessSessionLock } from './run/concurrency/session-lease.js';
export type { SessionLease, DistributedSessionLease } from './run/concurrency/session-lease.js';

// ── Session ACL (E6) ──
export {
  SessionAclService,
  SessionRoleCatalog,
  BUILTIN_SESSION_ROLES,
  computeEffectiveRights,
  intersectRights,
  applyRightsOverlay,
  exceedsRightsCeiling,
  L0_SESSION_RIGHTS_FLOOR,
} from './governance/session-acl/index.js';
export type {
  SessionRights,
  EffectiveSessionRights,
  SessionRoleDefinition,
  SessionParticipant,
  SessionAclConfig,
  AuthorizeRunResult,
  GrantResult,
  ReadScope,
  PrincipalRef,
  SessionSwitchMode,
  SwitchSessionResult,
} from './governance/session-acl/types.js';
export type { SessionSwitchRecord } from './session/types.js';
export type { RunAuditRecord } from './activation/types.js';
export { readSessionCompact, writeSessionCompact } from './session/compact.js';
export { compactStateKey } from './context/compact-key.js';

// ── Config Bridge ──
// (exported from agent-building above)

// ── Loop re-export（纯函数与协议类型；Agent 门面在 harness/agent） ──
export { agentLoop, callModel, classifyError } from '../loop/index.js';
export type { AgentContext, AgentTool, LoopToolResult, AgentLoopConfig, AgentLoopEvent, LoopObserver, ClassifiedError as LoopClassifiedError } from '../loop/index.js';

// ── Agent 门面（Harness） ──
export { Agent } from './run/agent/index.js';
export type { AgentOptions } from './run/agent/index.js';
export { withRunScope, getRunScope, getRunSessionId, createRunId } from './run/run-scope.js';
export type { RunScope, RunToolRuntime } from './run/run-scope.js';
export { ObserverHub } from './observability/observer/hub.js';
export {
  resolveObserverConfig,
  DEFAULT_OBSERVER_CONFIG,
  summarizeMessages,
} from './observability/observer/index.js';
export type {
  ObserverConfig,
  ObserverLevel,
  RunObservatorySnapshot,
  RunMessagesSnapshot,
  RunScopeView,
  RunMessageView,
  ResolvedObserverConfig,
  RunSecurityEventView,
  RunMemoryActivityView,
  RunToolEffectView,
} from './observability/observer/index.js';

// ── Harness 循环事件 ──
export type {
  HarnessLoopEvent,
  HarnessLoopExtension,
  BudgetExceededEvent,
  RunGuardRecoveredEvent,
  RunGuardStoppedEvent,
} from './run/reliability/harness-events.js';

// ── Harness 层类型 ──
export * from './shared/types/index.js';

// ── Concurrency re-exports ──
export * from './run/concurrency/tool-loop-detection.js';
export { StateMachine } from '../core/primitives/state-machine.js';
export type { StateTransition, StateMachineConfig } from '../core/primitives/state-machine.js';
export { createSessionStateMachine } from './session/state-machine.js';
export { AgentEvents } from './shared/events/agent-event-map.js';
export type { AgentEventMap, KnownAgentEventType, TypedAgentEvent } from './shared/events/agent-event-map.js';
export type { LoopEndReason, AgentEventDetail, AgentEventListener } from './shared/events/scenario-events.js';
export { AsyncTask, TaskTimeoutError, TaskCancelledError, spawnTask, TaskEvents } from './collaboration/orchestration/async-task.js';
export type { TaskOptions, TaskExecutor } from './collaboration/orchestration/async-task.js';
export type { AsyncTaskStore, AsyncTaskRecord, AsyncTaskStatus, AsyncTaskPriority, AsyncTaskFilter } from './collaboration/orchestration/async-task-store.js';
export * from './run/budget/index.js';
