/**
 * Integration 层统一导出
 *
 * Layer 3: 集成层
 * 协议适配、存储后端、沙盒、可观测性
 */

// ── Storage ──
export { JsonlSessionStore } from './storage/jsonl.js';
export { InMemorySessionStore } from './storage/memory.js';
export { SqliteSessionStore } from './storage/sqlite.js';
export { SessionArchiveManager } from './storage/archive-manager.js';
export type { ArchiveManagerOptions } from './storage/archive-manager.js';
export type { SqliteSessionStoreOptions } from './storage/sqlite.js';

// ── Observability ──
export { NoopObserver } from './observability/noop-observer.js';
export { LogObserver } from './observability/log-observer.js';

// ── MCP ──
export { SdkMcpClient, createSdkMcpClient } from './mcp/index.js';

// ── Web Search ──
export {
  createDuckDuckGoProvider,
  createTavilyProvider,
  createBraveProvider,
  createSerperProvider,
  createMimoProvider,
  createWebSearchProviderFromSlot,
  resolveWebSearchProviders,
  createWebSearchWithFallback,
} from './web-search/index.js';
export type {
  WebSearchConfig,
  WebSearchProviderSlotConfig,
  ResolvedWebSearchProviders,
} from './web-search/index.js';

// ── Agent Runtime sources（Integration 适配）──
export {
  channelMessageToTrigger,
  dispatchChannelMessage,
  WebhookSource,
  FileWatchSource,
} from './agent-runtime/index.js';
export type {
  ChannelMessageSourceOptions,
  WebhookSourceConfig,
  FileWatchSourceConfig,
} from './agent-runtime/index.js';

// ── Integration 层类型（canonical） ──
export * from './types/index.js';
