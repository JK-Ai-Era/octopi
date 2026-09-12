/**
 * Tavily Web Search Provider
 *
 * 为 LLM 设计的搜索 API，返回精炼摘要。
 * https://docs.tavily.com/
 */

import type { WebSearchProvider, WebSearchOptions, WebSearchResponse, WebSearchResultItem } from '../../core/interfaces/web-search.js';
import { fetchJson } from './http.js';

export interface TavilyProviderConfig {
  apiKey: string;
  baseUrl?: string;
  id?: string;
  timeoutMs?: number;
  /** basic | advanced */
  searchDepth?: 'basic' | 'advanced';
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
  score?: number;
}

interface TavilyApiResponse {
  query?: string;
  results?: TavilyResult[];
  response_time?: number;
}

export function createTavilyProvider(config: TavilyProviderConfig): WebSearchProvider {
  if (!config.apiKey) {
    throw new Error('Tavily provider requires apiKey');
  }

  const id = config.id ?? 'tavily';
  const baseUrl = (config.baseUrl ?? 'https://api.tavily.com').replace(/\/$/, '');
  const timeoutMs = config.timeoutMs ?? 15_000;
  const searchDepth = config.searchDepth ?? 'basic';

  return {
    id,
    name: 'Tavily',
    async search(query: string, options?: WebSearchOptions): Promise<WebSearchResponse> {
      const limit = Math.min(Math.max(options?.limit ?? 5, 1), 20);

      const body: Record<string, unknown> = {
        api_key: config.apiKey,
        query,
        max_results: limit,
        search_depth: searchDepth,
        include_answer: false,
        include_raw_content: false,
      };
      if (options?.timeRange === 'day' || options?.timeRange === 'week') {
        body.days = options.timeRange === 'day' ? 1 : 7;
      }

      const data = await fetchJson<TavilyApiResponse>(`${baseUrl}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs,
        signal: options?.signal,
      });

      const results: WebSearchResultItem[] = (data.results ?? [])
        .filter((r) => r.url && r.title)
        .slice(0, limit)
        .map((r, i) => ({
          title: r.title!,
          url: r.url!,
          snippet: r.content ?? '',
          publishedAt: r.published_date,
          rank: i + 1,
        }));

      return {
        query: data.query ?? query,
        provider: id,
        results,
      };
    },
  };
}
