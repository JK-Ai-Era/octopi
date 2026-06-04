// Core types
export * from './core/types.js';

// Agent runtime
export { AgentRunner, AgentRunnerConfig } from './agent/agent-runner.js';
// Backward compatibility alias
export { AgentRunner as AgentLoop } from './agent/agent-runner.js';
export { SessionManager } from './agent/session-manager.js';

// Gateway
export { Gateway } from './gateway/gateway.js';

// Context
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
