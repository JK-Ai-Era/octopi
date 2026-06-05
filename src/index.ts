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
// v2.0 新架构导出（推荐使用）
// ============================================================

// Core 层
export { AgentEngine } from './core/engine.js';
export { DefaultEventBus, NoopEventBus, AgentEvents } from './core/event-bus.js';
export { DefaultSecurityGuard } from './core/security-guard.js';
export { IterationBudget } from './core/budget.js';

// Harness 层
export { AgentBuilder, createAgent } from './harness/builder.js';
export { SessionAwareRunner } from './harness/runner.js';
export { loadPersona, composePersonas } from './harness/persona/loader.js';
export { DefaultContextPipeline } from './harness/context/pipeline.js';

// Integration 层
export { JsonlSessionStore } from './integration/storage/jsonl.js';
export { InMemorySessionStore } from './integration/storage/memory.js';
export { NoopObserver } from './integration/observability/noop-observer.js';
export { LogObserver } from './integration/observability/log-observer.js';

// 安全
export { CapabilityEnforcer, PluginTrustLevel } from './harness/security/capability-enforcer.js';
export { SecurityPresets, getSecurityPolicy } from './harness/security/policy.js';

// ============================================================
// v0.1.x 向后兼容导出（deprecated）
// ============================================================

/** @deprecated 使用 AgentBuilder 代替 */
export { AgentRunner } from './agent/agent-runner.js';
export type { AgentRunnerConfig } from './agent/agent-runner.js';
/** @deprecated 使用 AgentBuilder 代替 */
export { AgentRunner as AgentLoop } from './agent/agent-runner.js';
/** @deprecated 使用 SessionAwareRunner 代替 */
export { SessionManager } from './agent/session-manager.js';

// Gateway
export { Gateway } from './gateway/gateway.js';

// Context（deprecated — 使用 DefaultContextPipeline）
export { LegacyContextEngine } from './context/engine.js';

// Tools
export { ToolRegistry } from './tools/registry.js';
export { getBuiltinTools, createShellTool, createFileReadTool, createFileWriteTool, createFileListTool } from './tools/builtin.js';

// Providers
export { LLMRouter } from './providers/router.js';
export { OpenAIProvider } from './providers/openai.js';
export { AnthropicProvider } from './providers/anthropic.js';

// Plugins
export { PluginManager } from './plugins/manager.js';
export { definePluginEntry, defineChannelPluginEntry } from './plugins/entry.js';
export type { OctopiPluginDefinition, OctopiChannelPluginDefinition } from './plugins/entry.js';
export { PluginApi } from './plugins/api.js';
export { PluginLoader } from './plugins/loader.js';
export type { LoadedPlugin, PluginLoaderConfig, PluginEntryConfig } from './plugins/loader.js';
export { CapabilityRegistry } from './plugins/capability.js';
export { validateManifest, parseManifest } from './plugins/manifest.js';
export type { PluginManifest, PluginContracts, ActivationConfig } from './plugins/manifest.js';

// Skills
export { DefaultSkillManager } from './skills/manager.js';

// Protocol
export { HttpChannelAdapter } from './protocol/http.js';

// Config
export { loadConfig, toGatewayConfig } from './config.js';
export type { HarnessConfig, ProviderConfig, ChannelConfig } from './config.js';

// Core types（全部导出）
export * from './core/types.js';
