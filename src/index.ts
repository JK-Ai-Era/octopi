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
 * import { AgentBuilder } from 'octopi/harness';
 *
 * const { engine, runner } = await new AgentBuilder()
 *   .model('gpt-4')
 *   .persona('./my-agent')
 *   .build();
 * ```
 */

// ============================================================
// Core 层
// ============================================================

export { AgentEngine } from './core/engine.js';
export { DefaultEventBus, NoopEventBus, AgentEvents } from './core/event-bus.js';
export { DefaultSecurityGuard } from './core/security-guard.js';
export { IterationBudget } from './core/budget.js';

// Core 接口
export type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk, ToolDefinition } from './core/interfaces/model-provider.js';
export type { ToolExecutor, ExecutionContext } from './core/interfaces/tool-executor.js';
export type { ContextPipeline, PipelineInput, PipelineOutput } from './core/interfaces/context-pipeline.js';
export type { ErrorStrategy, ErrorAction, OverflowAction, SecurityAction } from './core/interfaces/error-strategy.js';
export type { Observer, Span, LogLevel } from './core/interfaces/observer.js';
export type { SessionStore, SessionData } from './core/interfaces/session-store.js';

// ============================================================
// Harness 层
// ============================================================

export { AgentBuilder, createAgent } from './harness/builder.js';
export { SessionAwareRunner } from './harness/runner.js';
export { loadPersona, composePersonas } from './harness/persona/loader.js';
export { DefaultContextPipeline } from './harness/context/pipeline.js';

// ============================================================
// Integration 层
// ============================================================

// 存储
export { JsonlSessionStore } from './integration/storage/jsonl.js';
export { InMemorySessionStore } from './integration/storage/memory.js';

// 可观测性
export { NoopObserver } from './integration/observability/noop-observer.js';
export { LogObserver } from './integration/observability/log-observer.js';

// ============================================================
// 安全
// ============================================================

export { CapabilityEnforcer, PluginTrustLevel } from './harness/security/capability-enforcer.js';
export { SecurityPresets, getSecurityPolicy } from './harness/security/policy.js';

// ============================================================
// Gateway
// ============================================================

export { Gateway } from './gateway/gateway.js';

// ============================================================
// Tools
// ============================================================

export { ToolRegistry } from './tools/registry.js';
export { getBuiltinTools, createShellTool, createFileReadTool, createFileWriteTool, createFileListTool } from './tools/builtin.js';

// ============================================================
// Providers
// ============================================================

export { OpenAIProvider } from './providers/openai.js';
export type { OpenAIProviderConfig } from './providers/openai.js';
export { AnthropicProvider } from './providers/anthropic.js';
export type { AnthropicProviderConfig } from './providers/anthropic.js';

// ============================================================
// Plugins
// ============================================================

export { PluginManager } from './plugins/manager.js';
export { definePluginEntry, defineChannelPluginEntry } from './plugins/entry.js';
export type { OctopiPluginDefinition, OctopiChannelPluginDefinition } from './plugins/entry.js';
export { PluginApi } from './plugins/api.js';
export { PluginLoader } from './plugins/loader.js';
export type { LoadedPlugin, PluginLoaderConfig, PluginEntryConfig } from './plugins/loader.js';
export { CapabilityRegistry } from './plugins/capability.js';
export { validateManifest, parseManifest } from './plugins/manifest.js';
export type { PluginManifest, PluginContracts, ActivationConfig } from './plugins/manifest.js';

// ============================================================
// Skills
// ============================================================

export { DefaultSkillManager } from './skills/manager.js';

// ============================================================
// Protocol
// ============================================================

export { HttpChannelAdapter } from './protocol/http.js';

// ============================================================
// Config
// ============================================================

export { loadConfig, toGatewayConfig, createProviderFromConfig, createStoreFromConfig } from './config.js';
export type { HarnessConfig, AgentConfig, ProviderConfig, ChannelConfig, PluginConfig, StoreConfig } from './config.js';

// Config Bridge（配置文件 → 新架构）
export { buildFromConfig, buildFromConfigFile } from './harness/config-bridge.js';
export type { BuiltAgent } from './harness/config-bridge.js';

// ============================================================
// Init
// ============================================================

export { initOctopi, ensureAgentDirs, isInitialized, getOctopiHome, formatInitReport } from './init.js';

// ============================================================
// Observability
// ============================================================

export { TraceLogger, TraceCollector, getTraceLogger, resetTraceLogger, TraceLevel, TRACE_LEVEL_NAMES, TRACE_EVENTS, ConsoleExporter, JsonlFileExporter, WebhookExporter, createExporter, MetricsAggregator, formatMetricsSnapshot } from './observability/index.js';
export type { TraceEvent, TraceLoggerConfig, TraceCollectorConfig, TraceExporter, ExporterConfig, AnyExporterConfig, MetricsSnapshot, LatencyStats, MetricsAggregatorConfig } from './observability/index.js';

// ============================================================
// Testing
// ============================================================

export { RecordingProvider, ReplayProvider, createReplayProvider, ScenarioRunner, runScenario, formatScenarioResult, ChaosProvider, compose, extendScenario, runParameterized, formatParameterizedResults, BuiltinScenarios, notEmpty, contains, notContains, callsTool, noToolCalls, lengthBetween, matches } from './testing/index.js';
export type { RecordingEntry, RecordingConfig, ReplayConfig, Scenario, ScenarioAssertion, ScenarioResult, TurnResult, ScenarioRunnerConfig, ChaosProviderConfig, ChaosRule, ScenarioFragment, ParameterizedResult } from './testing/index.js';

// ============================================================
// Core types（全部导出）
// ============================================================

export * from './core/types.js';
