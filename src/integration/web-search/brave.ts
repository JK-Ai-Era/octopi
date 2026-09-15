/**
 * Brave Search API Provider
 *
 * https://api-dashboard.search.brave.com/app/documentation
 */

import type { WebSearchProvider, WebSearchOptions, WebSearchResponse, WebSearchResultItem } from '../../harness/plugin-ecosystem/tools/web-search-types.js';
import { fetchJson } from './http.js';

export interface BraveProviderConfig {
  apiKey: string;
  baseUrl?: string;
  id?: string;
  timeoutMs?: number;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  page_age?: string;
}

interface BraveApiResponse {
  web?: {
    results?: BraveWebResult[];
    total?: number;
  };
  query?: { original?: string };
}

export function createBraveProvider(config: BraveProviderConfig): WebSearchProvider {
  if (!config.apiKey) {
    throw new Error('Brave provider requires apiKey');
  }

  const id = config.id ?? 'brave';
  const baseUrl = (config.baseUrl ?? 'https://api.search.brave.com').replace(/\/$/, '');
  const timeoutMs = config.timeoutMs ?? 15_000;

  return {
    id,
    name: 'Brave Search',
    async search(query: string, options?: WebSearchOptions): Promise<WebSearchResponse> {
      const limit = Math.min(Math.max(options?.limit ?? 5, 1), 20);
      const params = new URLSearchParams({
        q: query,
        count: String(limit),
      });
      if (options?.region) params.set('country', options.region.split('-')[0]?.toUpperCase() ?? options.region);

      const safe = options?.safeSearch;
      if (safe === 'strict') params.set('safesearch', 'strict');
      else if (safe === 'moderate') params.set('safesearch', 'moderate');
      else if (safe === 'off') params.set('safesearch', 'off');

      if (options?.timeRange === 'day') params.set('freshness', 'pd');
      else if (options?.timeRange === 'week') params.set('freshness', 'pw');
      else if (options?.timeRange === 'month') params.set('freshness', 'pm');

      const data = await fetchJson<BraveApiResponse>(`${baseUrl}/res/v1/web/search?${params.toString()}`, {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': config.apiKey,
        },
        timeoutMs,
        signal: options?.signal,
      });

      const results: WebSearchResultItem[] = (data.web?.results ?? [])
        .filter((r) => r.url && r.title)
        .slice(0, limit)
        .map((r, i) => ({
          title: r.title!,
          url: r.url!,
          snippet: r.description ?? '',
          publishedAt: r.page_age,
          rank: i + 1,
        }));

      return {
        query: data.query?.original ?? query,
        provider: id,
        results,
        total: data.web?.total,
      };
    },
  };
}
