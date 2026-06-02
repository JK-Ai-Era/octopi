/**
 * Plugin System — 对齐 OpenClaw 的 Plugin 架构
 *
 * 核心概念：
 * - Plugin = 能力的所有权边界（Provider/Channel/Tool/Hook 等）
 * - definePluginEntry() = 创建 plugin 的标准方式
 * - PluginApi = plugin register() 回调中接收的 api 对象
 * - PluginManifest = 声明式元数据（octopi.plugin.json）
 * - PluginLoader = 发现和加载 plugins
 * - PluginManager = 管理 plugin 生命周期和 hook 执行
 * - CapabilityRegistry = 能力注册中心
 *
 * 参考: https://docs.openclaw.ai/plugins/overview
 */

// ── 定义和创建 ──
export { definePluginEntry, defineChannelPluginEntry } from './entry.js';
export type { OctopiPluginDefinition, OctopiChannelPluginDefinition } from './entry.js';

// ── Plugin API ──
export { PluginApi } from './api.js';
export type {
  PluginLogger,
  HookRegistrationOptions,
  ToolRegistrationOptions,
  ProviderRegistration,
  ChannelRegistration,
} from './api.js';

// ── Manifest ──
export { validateManifest, parseManifest } from './manifest.js';
export type {
  PluginManifest,
  PluginContracts,
  ActivationConfig,
  SetupConfig,
  JsonSchema,
} from './manifest.js';

// ── Capability Registry ──
export { CapabilityRegistry, registerManifestCapabilities } from './capability.js';
export type { CapabilityType, CapabilityRecord } from './capability.js';

// ── Plugin Loader ──
export { PluginLoader } from './loader.js';
export type { LoadedPlugin, PluginLoaderConfig, PluginEntryConfig } from './loader.js';

// ── Plugin Manager ──
export { PluginManager } from './manager.js';
export type {
  // Hook Event Types
  BeforeModelResolveEvent,
  AgentTurnPrepareEvent,
  BeforePromptBuildEvent,
  BeforeAgentRunEvent,
  BeforeAgentReplyEvent,
  BeforeAgentFinalizeEvent,
  AgentEndEvent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  MessageReceivedEvent,
  MessageSendingEvent,
  MessageSentEvent,
  SessionLifecycleEvent,
  CompactionEvent,
  GatewayLifecycleEvent,
  BeforeInstallEvent,
  // Hook Result Types
  ModelResolveResult,
  PromptBuildResult,
  AgentRunResult,
  AgentReplyResult,
  AgentFinalizeResult,
  ToolCallResult,
  MessageSendingResult,
  InstallResult,
} from './manager.js';
