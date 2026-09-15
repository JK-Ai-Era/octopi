/**
 * Integration 层 Web Search 统一导出
 */

export type {
  WebSearchProvider,
  WebSearchOptions,
  WebSearchResponse,
  WebSearchResultItem,
} from '../../harness/plugin-ecosystem/tools/web-search-types.js';

export { createDuckDuckGoProvider } from './duckduckgo.js';
export type { DuckDuckGoProviderConfig } from './duckduckgo.js';

export { createTavilyProvider } from './tavily.js';
export type { TavilyProviderConfig } from './tavily.js';

export { createBraveProvider } from './brave.js';
export type { BraveProviderConfig } from './brave.js';

export { createSerperProvider } from './serper.js';
export type { SerperProviderConfig } from './serper.js';

export { createMimoProvider } from './mimo.js';
export type { MimoProviderConfig, MimoUserLocation } from './mimo.js';

export {
  createWebSearchProviderFromSlot,
  resolveWebSearchProviders,
  createWebSearchWithFallback,
} from './factory.js';
export type {
  WebSearchConfig,
  WebSearchProviderSlotConfig,
  ResolvedWebSearchProviders,
} from './factory.js';
