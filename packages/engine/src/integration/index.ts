/**
 * Integration 层（engine 拥有的库能力）
 *
 * gateway / protocols / tui / web / types 不在本包（见 arch/npm-package-split.md §3.3）。
 */

// ── Storage ──
export { JsonlSessionStore } from './storage/jsonl.js';
export { InMemorySessionStore } from './storage/memory.js';
export { SessionArchiveManager } from './storage/archive-manager.js';
export type { ArchiveManagerOptions } from './storage/archive-manager.js';
export {
  createSqliteSessionIndex,
  rebuildSessionIndexFromStore,
  ensureSessionIndexFresh,
} from './storage/session-index.js';
export type {
  SessionIndexBackend,
  SessionIndexSink,
  SessionIndexPrefilterQuery,
  SessionIndexCandidate,
} from './storage/session-index.js';

// ── Observability ──
export { NoopObserver } from './observability/noop-observer.js';
export { LogObserver } from './observability/log-observer.js';
export { createRunTelemetry } from './observability/run-telemetry.js';

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

// ── Agent Runtime sources ──
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

// ── Providers ──
export { OpenAIProvider } from './providers/openai.js';
export type { OpenAIProviderConfig } from './providers/openai.js';
export { AnthropicProvider } from './providers/anthropic.js';
export type { AnthropicProviderConfig } from './providers/anthropic.js';
