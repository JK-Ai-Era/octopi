/**
 * Web Search Provider 工厂
 *
 * 从配置创建 provider 实例，并组装 fallback 链。
 * 与 LLM 的 createProviderFromConfig 对等，作为组合根的一部分。
 */

import type { WebSearchProvider, WebSearchResponse } from '../../harness/plugin-ecosystem/tools/web-search-types.js';

import { createDuckDuckGoProvider } from './duckduckgo.js';
import { createTavilyProvider } from './tavily.js';
import { createBraveProvider } from './brave.js';
import { createSerperProvider } from './serper.js';
import { createMimoProvider } from './mimo.js';

/** 单个 provider 配置 */
export interface WebSearchProviderSlotConfig {
  /** 实现类型 */
  api: 'duckduckgo' | 'tavily' | 'brave' | 'serper' | 'mimo';
  /** API Key（duckduckgo 可省略；支持 ${ENV} 展开后的明文） */
  apiKey?: string;
  /** 覆盖默认 baseUrl */
  baseUrl?: string;
  /** 覆盖默认超时 */
  timeoutMs?: number;
  /** MiMo 专用：模型 ID（默认 mimo-v2.5-pro） */
  model?: string;
  /** MiMo 专用：搜索关键词数上限（max_keyword，默认 3） */
  maxKeyword?: number;
  /** MiMo 专用：是否强制搜索（force_search，默认 true） */
  forceSearch?: boolean;
  /** MiMo 专用：用户位置 */
  userLocation?: { country?: string; region?: string; city?: string };
}

/** webSearch 顶层配置 */
export interface WebSearchConfig {
  /** 主 provider key（对应 providers 的 key） */
  provider?: string;
  /** 失败时依次降级的 provider key */
  fallbacks?: string[];
  /** 默认结果数 */
  defaultLimit?: number;
  /** 全局超时（毫秒），会被 slot.timeoutMs 覆盖 */
  timeoutMs?: number;
  /** provider 映射 */
  providers?: Record<string, WebSearchProviderSlotConfig>;
}

/** MiMo 走完整 Chat Completions + 联网，需要更长超时 */
const MIMO_MIN_TIMEOUT_MS = 90_000;

/**
 * 从单个 slot 配置创建 WebSearchProvider
 *
 * @param key - 配置中的 provider 名称（作为实例 id）
 * @param slot - slot 配置
 * @param opts.defaultTimeoutMs - 顶层 webSearch.timeoutMs，slot 未指定时继承
 */
export function createWebSearchProviderFromSlot(
  key: string,
  slot: WebSearchProviderSlotConfig,
  opts: { defaultTimeoutMs?: number } = {},
): WebSearchProvider {
  let timeoutMs = slot.timeoutMs ?? opts.defaultTimeoutMs;

  if (slot.api === 'mimo') {
    if (timeoutMs === undefined || timeoutMs < MIMO_MIN_TIMEOUT_MS) {
      if (timeoutMs !== undefined) {
        console.warn(
          `[WebSearch] mimo timeoutMs=${timeoutMs} is too low for LLM web search, raising to ${MIMO_MIN_TIMEOUT_MS}`,
        );
      }
      timeoutMs = MIMO_MIN_TIMEOUT_MS;
    }
  }

  switch (slot.api) {
    case 'duckduckgo':
      return createDuckDuckGoProvider({ id: key, timeoutMs });
    case 'tavily':
      return createTavilyProvider({
        id: key,
        apiKey: slot.apiKey ?? '',
        baseUrl: slot.baseUrl,
        timeoutMs,
      });
    case 'brave':
      return createBraveProvider({
        id: key,
        apiKey: slot.apiKey ?? '',
        baseUrl: slot.baseUrl,
        timeoutMs,
      });
    case 'serper':
      return createSerperProvider({
        id: key,
        apiKey: slot.apiKey ?? '',
        baseUrl: slot.baseUrl,
        timeoutMs,
      });
    case 'mimo':
      return createMimoProvider({
        id: key,
        apiKey: slot.apiKey ?? '',
        baseUrl: slot.baseUrl,
        timeoutMs,
        model: slot.model,
        maxKeyword: slot.maxKeyword,
        forceSearch: slot.forceSearch,
        userLocation: slot.userLocation,
      });
    default: {
      const exhaustive: never = slot.api;
      throw new Error(`Unknown web search provider api: ${String(exhaustive)}`);
    }
  }
}

export interface ResolvedWebSearchProviders {
  /** 主 provider；未配置时为 undefined */
  primary?: WebSearchProvider;
  /** 主 provider 的配置 key */
  primaryKey?: string;
  /** 主 provider 的 api 类型 */
  primaryApi?: string;
  /** fallback 链（按配置顺序，已实例化） */
  fallbacks: WebSearchProvider[];
  /** 默认结果数 */
  defaultLimit: number;
  /** 全局超时 */
  timeoutMs: number;
}

/**
 * 解析完整 webSearch 配置
 *
 * 规则：
 * - providers 为空 → 返回空 primary（不注册工具）
 * - provider 未指定 → 取 providers 第一个 key
 * - fallbacks 引用不存在的 key → 跳过并警告
 * - 若 primary 失败配置且存在 duckduckgo → 自动放入 fallbacks 末尾
 */
export function resolveWebSearchProviders(config?: WebSearchConfig): ResolvedWebSearchProviders {
  const providers = config?.providers ?? {};
  const keys = Object.keys(providers);
  const defaultLimit = config?.defaultLimit ?? 5;
  let timeoutMs = config?.timeoutMs ?? 15_000;

  if (keys.length === 0) {
    return { fallbacks: [], defaultLimit, timeoutMs };
  }

  const primaryKey = config?.provider && providers[config.provider]
    ? config.provider
    : keys[0]!;
  const primarySlot = providers[primaryKey]!;

  // 工具级 timeout 必须覆盖 LLM 型 provider，否则 agent 循环会先掐断请求
  if (primarySlot.api === 'mimo' && timeoutMs < MIMO_MIN_TIMEOUT_MS) {
    timeoutMs = MIMO_MIN_TIMEOUT_MS;
  }

  const slotOpts = { defaultTimeoutMs: timeoutMs };
  const primary = createWebSearchProviderFromSlot(primaryKey, primarySlot, slotOpts);

  const fallbackKeys = (config?.fallbacks ?? []).filter((k) => {
    if (providers[k]) return true;
    console.warn(`[WebSearch] Fallback provider "${k}" not found in providers, skipping`);
    return false;
  });

  // 避免 fallback 重复包含 primary
  const uniqueFallbackKeys = fallbackKeys.filter((k) => k !== primaryKey);
  const fallbacks = uniqueFallbackKeys.map((k) =>
    createWebSearchProviderFromSlot(k, providers[k]!, slotOpts),
  );

  // 未显式配置 fallbacks 字段时，主 provider 非 DuckDuckGo 则自动追加免费兜底
  const primaryIsDuckDuckGo = primarySlot.api === 'duckduckgo';
  if (
    config?.fallbacks === undefined &&
    fallbacks.length === 0 &&
    !primaryIsDuckDuckGo
  ) {
    fallbacks.push(createDuckDuckGoProvider({ id: 'duckduckgo', timeoutMs: 15_000 }));
  }

  return {
    primary,
    primaryKey,
    primaryApi: primarySlot.api,
    fallbacks,
    defaultLimit,
    timeoutMs,
  };
}

/**
 * 创建带 fallback 的搜索函数
 *
 * 降级条件：
 * - provider 抛错
 * - provider 成功但 results 为空（如 DDG HTML 抓取失败、模型无引用）
 *
 * 全链路无结果时：若存在空响应则返回最后一个空响应（不抛错），
 * 否则抛出聚合错误。
 *
 * @param primary - 主 provider
 * @param fallbacks - 失败/空结果时依次尝试
 */
export function createWebSearchWithFallback(
  primary: WebSearchProvider,
  fallbacks: WebSearchProvider[] = [],
): WebSearchProvider {
  const chain = [primary, ...fallbacks];

  return {
    id: primary.id,
    name: primary.name,
    async search(query, options) {
      const failures: string[] = [];
      let lastEmpty: WebSearchResponse | undefined;

      for (const provider of chain) {
        try {
          const response = await provider.search(query, options);
          if (response.results.length > 0) {
            return response;
          }
          lastEmpty = response;
          failures.push(`${provider.id}: empty results`);
          console.warn(`[WebSearch] ${provider.id} returned empty results, trying next provider`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`${provider.id}: ${message}`);
        }
      }

      if (lastEmpty) {
        return lastEmpty;
      }

      throw new Error(`All web search providers failed: ${failures.join('; ')}`);
    },
  };
}
