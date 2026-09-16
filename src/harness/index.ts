/**
 * Harness 层统一导出（Layer 2）
 *
 * 15 个自包含领域，每个领域通过 index.ts 导出。
 */

// ── Tool 系统 ──
export { createToolSet } from './plugin-ecosystem/tools/tool-set.js';
export type { ToolSet, ToolSetConfig } from './plugin-ecosystem/tools/tool-set.js';
export { createWebSearchTool } from './plugin-ecosystem/tools/web-search.js';
export type { WebSearchToolOptions } from './plugin-ecosystem/tools/web-search.js';

// ── Agent Building ──
export { AgentBuilder, createAgent } from './agent-building/builder.js';
export { loadPersona, composePersonas, PersonaSource } from './agent-building/persona.js';
export { buildFromConfig, buildFromConfigFile, resolveProviders, resolveSecurityConfig, resolveContextEngine, resolveRunGuard } from './agent-building/config-bridge.js';
export type { BuiltAgent } from './agent-building/config-bridge.js';

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
  ContextCompactReason,
  ContextCompactEvent,
  ContextEmitFn,
  ContextCompactSnapshot,
} from './context/index.js';

// ── Security ──
export { CapabilityEnforcer, PluginTrustLevel } from './security/capability-enforcer.js';
export { SecurityPresets, getSecurityPolicy } from './security/policy.js';
export type { Environment } from './security/policy.js';

// ── Reliability ──
export { runAgentWithReliability, DEFAULT_RELIABILITY_CONFIG } from './reliability/index.js';
export type { ReliabilityConfig, ConcreteReliabilityHarness } from './reliability/index.js';
export type { ReliabilityHarness, ResourceBudgetLike } from '../core/interfaces/reliability.js';
export { RunMetricsCollector } from './reliability/run-metrics-collector.js';
export { CircuitBreaker } from './reliability/circuit-breaker.js';
export { wrapProviderWithCircuitBreaker } from './reliability/provider-wrapper.js';
export { FallbackProvider } from './reliability/fallback-provider.js';

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
export { DefaultToolBus } from './plugin-ecosystem/tools/tool-bus.js';
export { getBuiltinTools, createShellTool, createFileReadTool, createFileWriteTool, createFileListTool } from './plugin-ecosystem/tools/builtin.js';
export { DefaultSkillManager, FileSystemSkillSource } from './plugin-ecosystem/skills/manager.js';
export type { SkillSource, DiscoveredSkill } from './plugin-ecosystem/skills/manager.js';
export type { SkillDefinition, SkillManager } from './plugin-ecosystem/skills/types.js';
export type { AgentPersona, ModelConfig, AgentDefinition } from './types/agent-definition.js';
export { DefaultMcpManager, mcpToolToOctopiDefinition, extractMcpToolResult, splitNamespacedToolName, MCP_NAMESPACE_SEP, loadMcpServersFromDir, DEFAULT_MCP_SERVERS_DIR } from './plugin-ecosystem/mcp/index.js';
export type { McpClientFactory, McpManagerCallbacks, McpClient, McpManager, McpServerConfig } from './plugin-ecosystem/mcp/index.js';
export type { WebSearchProvider, WebSearchOptions, WebSearchResponse } from './plugin-ecosystem/tools/web-search-types.js';

// ── Multi-Agent ──
export { DefaultAgentRegistry, AgentSwarm, RoundRobinStrategy, CapabilityStrategy, PipelineStrategy, SwarmEvents, AgentProcess, spawnAgentProcess, forkAgentProcess, AgentProcessEvents } from './multi-agent/index.js';
export type { SwarmTopology, SwarmConfig, SwarmAgent, SwarmTask, OrchestrationStrategy, AgentProcessState, AgentProcessResult, AgentProcessAnnounce, AgentProcessConfig, AgentRegistry, AgentInfo, AgentQuery, AgentRelation } from './multi-agent/index.js';
export { AgentRegistryEvents } from './multi-agent/agent-registry-types.js';

// ── HITL / Execution Environment ──
export type { ApprovalLevel, ApprovalProvider, ApprovalPolicy, ApprovalRequest, ApprovalDecision } from './human-in-the-loop/types.js';
export type { MessageChannel, ProcessMessage, MessageHandler } from './multi-agent/message-channel-types.js';
export type { SandboxProvider, Workspace, SandboxResult, IsolationLevel } from './execution-environment/types.js';
export type { EventSource, EventSourceDescriptor, ExternalEvent } from './agent-runtime/event-source-types.js';

// ── Autonomous Subsystem ──
export { SubsystemRuntime } from './autonomous-subsystem/runtime.js';
export type { SharedDeps, SubsystemRuntimeConfig } from './autonomous-subsystem/runtime.js';
export { SubsystemLoader } from './autonomous-subsystem/loader.js';
export type { SubsystemLoaderConfig, LoadResult } from './autonomous-subsystem/loader.js';
export { SenseEngine, MetricsStore } from './autonomous-subsystem/sense/index.js';
export { ThinkExecutor, ModelResolver } from './autonomous-subsystem/think/index.js';
export {
  createSubsystemLLMPort,
  DEP_LLM_PORT,
  DEP_SUBSYSTEM_PROMPT,
  DEP_RESOLVED_MODEL,
  DEP_RESOLVED_MODELS,
} from './autonomous-subsystem/think/index.js';
export type {
  SubsystemLLMPort,
  SubsystemLLMPortChatRequest,
} from './autonomous-subsystem/think/index.js';
export { SignalBus } from './autonomous-subsystem/signal/index.js';
export { SubsystemSessionManager, parseTTL } from './autonomous-subsystem/session/index.js';
export { AuditWriter, AuditReader } from './autonomous-subsystem/audit/index.js';
export { validateSubsystemSpec } from './autonomous-subsystem/boundary/index.js';

// ── Session Tasks（会话任务，Session 聚合）──
export { SessionTaskService, renderSessionTasksInjection, createSessionTaskTools } from './session-tasks/index.js';
export type { SessionTask, SessionTaskStatus, SessionTaskListFilter } from './session-tasks/index.js';

// ── Run Guard（过程监督）──
// AgentSupervisor 已归档（arch/agent-runtime.md §10）
export { DefaultRunGuard, createRunGuard } from './run-guard/index.js';
export type { RunGuardConfig } from './run-guard/index.js';

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
} from './agent-runtime/index.js';
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
} from './agent-runtime/index.js';

// ── Knowledge（Context Intelligence 第 4 层）──
export { MemoryKnowledgeStore, KnowledgeContextEngine } from './context/knowledge/index.js';
export type { KnowledgeStore, KnowledgeEntry, KnowledgeType, KnowledgeStats, RetrieveOptions, KnowledgeContextEngineConfig } from './context/knowledge/index.js';

// ── Orchestration（experimental，默认不进主路径；见 octopi/harness/orchestration）──

// ── Concurrency ──
// (exported from concurrency/index.ts)

// ── Resources ──
export { ResourceManager } from './resources/index.js';
export type { TokenBudgetConfig, ModelPricing, RateLimitConfig, TokenCheckResult, RateLimitCheckResult, ResourceStats } from './resources/index.js';

// ── Memory ──
export { InMemoryMemoryStore, InMemoryConceptGraph, AgentDatabase, SqliteMemoryStore, SqliteWisdomStore, SqliteConceptGraph, KnowledgeRegistry, createEmbeddingProvider } from './memory/index.js';
export type { AgentDatabaseOptions, SqliteMemoryStoreOptions, SqliteConceptGraphOptions, EmbeddingProvider, EmbeddingConfig, KnowledgeSourceEntry } from './memory/index.js';

// ── Memory 领域类型 ──
export type { MemoryType, MemoryEntry, MemoryQuery, MemoryStats, MemoryStore } from './memory/types.js';
export type { WisdomEntry, WisdomStore } from './memory/types.js';
export type { ConceptNode, ConceptEdge, ConceptGraph, ConceptGraphStore } from './memory/types.js';
export type {
  Planner, Reflector, AgentState, AgentStats, Plan, PlanStep,
  StepResult, ExecutionRecord, Assessment, Pattern,
} from './orchestration/cognitive-loop.js';

// ── Session 类型 ──
export type { SessionData, SessionLifecycleMeta, SessionLifecycleStatus, MemoryExtractionStatus } from './session-types.js';

// ── Runner ──
export { SessionAwareRunner } from './runner.js';
export type { SessionAwareRunnerConfig } from './runner.js';

// ── Config Bridge ──
// (exported from agent-building above)

// ── Loop re-export（纯函数与协议类型；Agent 门面在 harness/agent） ──
export { agentLoop, callModel, classifyError } from '../loop/index.js';
export type { AgentContext, AgentTool, LoopToolResult, AgentLoopConfig, AgentLoopEvent, LoopObserver, ClassifiedError as LoopClassifiedError } from '../loop/index.js';

// ── Agent 门面（Harness） ──
export { Agent } from './agent/index.js';
export type { AgentOptions } from './agent/index.js';

// ── Harness 循环事件 ──
export type {
  HarnessLoopEvent,
  HarnessLoopExtension,
  BudgetExceededEvent,
  RunGuardRecoveredEvent,
  RunGuardStoppedEvent,
} from './reliability/harness-events.js';

// ── Harness 层类型 ──
export * from './types/index.js';

// ── Concurrency re-exports ──
export * from './concurrency/tool-loop-detection.js';
export { StateMachine } from '../core/primitives/state-machine.js';
export type { StateTransition, StateMachineConfig } from '../core/primitives/state-machine.js';
export { createSessionStateMachine } from './session-state-machine.js';
export { AgentEvents } from './events/agent-event-map.js';
export type { AgentEventMap, KnownAgentEventType, TypedAgentEvent } from './events/agent-event-map.js';
export type { LoopEndReason, AgentEventDetail, AgentEventListener } from './events/scenario-events.js';
export { AsyncTask, TaskTimeoutError, TaskCancelledError, spawnTask, TaskEvents } from './orchestration/async-task.js';
export type { TaskOptions, TaskExecutor } from './orchestration/async-task.js';
export type { AsyncTaskStore, AsyncTaskRecord, AsyncTaskStatus, AsyncTaskPriority, AsyncTaskFilter } from './orchestration/async-task-store.js';
export * from './budget/index.js';
