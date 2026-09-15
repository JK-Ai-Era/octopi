/**
 * web_search 工具 — 网络搜索
 *
 * 通过依赖注入接收 WebSearchProvider（本域 web-search-types 契约），
 * 不 import 具体 provider 实现（保持依赖方向：Harness → Core）。
 */

import type { RegisteredTool } from '../../../core/types.js';
import type { WebSearchProvider, WebSearchOptions } from './web-search-types.js';

export interface WebSearchToolOptions {
  /** 默认返回条数 */
  defaultLimit?: number;
  /** 全局超时（毫秒），与 definition.timeoutMs 对齐 */
  timeoutMs?: number;
  /** 额外 provider（用于日志展示可用列表） */
  availableProviders?: string[];
}

/**
 * 创建 web_search 工具
 *
 * @param provider - 已注入的搜索实现（通常已含 fallback）
 * @param options - 工具默认参数
 */
export function createWebSearchTool(
  provider: WebSearchProvider,
  options: WebSearchToolOptions = {},
): RegisteredTool {
  const defaultLimit = options.defaultLimit ?? 5;
  // LLM 型 provider（如 mimo）需要更长超时，避免 agent 循环先掐断
  const timeoutMs = options.timeoutMs ?? 90_000;

  return {
    definition: {
      name: 'web_search',
      description:
        'Search the web for current information. Returns titles, URLs, and snippets. ' +
        'Use when you need up-to-date facts, documentation, news, or sources outside the local workspace.',
      parameters: {
        query: {
          type: 'string',
          description: 'Search query text',
          required: true,
          minLength: 1,
          maxLength: 512,
        },
        limit: {
          type: 'number',
          description: `Maximum number of results (default: ${defaultLimit}, max: 20)`,
          minimum: 1,
          maximum: 20,
        },
        region: {
          type: 'string',
          description: 'Region/language hint, e.g. "us-en", "cn-zh", "wt-wt" (optional)',
        },
        safe_search: {
          type: 'string',
          description: 'Safe search level',
          enum: ['off', 'moderate', 'strict'],
        },
        time_range: {
          type: 'string',
          description: 'Filter results by recency',
          enum: ['day', 'week', 'month', 'year'],
        },
      },
      timeoutMs,
    },
    source: {
      kind: 'builtin',
      origin: 'web-search',
      trustLevel: 'builtin',
    },
    handler: async (args, context) => {
      const query = (args.query as string | undefined)?.trim();
      if (!query) {
        throw new Error('web_search requires a non-empty query');
      }

      const limit = Math.min(
        Math.max((args.limit as number | undefined) ?? defaultLimit, 1),
        20,
      );

      const searchOptions: WebSearchOptions = {
        limit,
        region: args.region as string | undefined,
        safeSearch: args.safe_search as WebSearchOptions['safeSearch'],
        timeRange: args.time_range as WebSearchOptions['timeRange'],
        signal: context?.abortSignal,
      };

      const response = await provider.search(query, searchOptions);

      return {
        query: response.query,
        provider: response.provider,
        results: response.results,
        total: response.total ?? response.results.length,
        ...(response.answer ? { answer: response.answer } : {}),
        ...(options.availableProviders?.length
          ? { availableProviders: options.availableProviders }
          : {}),
      };
    },
  };
}
