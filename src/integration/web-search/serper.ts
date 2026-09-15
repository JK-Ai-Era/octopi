/**
 * Serper (Google) Web Search Provider
 *
 * https://serper.dev/
 */

import type { WebSearchProvider, WebSearchOptions, WebSearchResponse, WebSearchResultItem } from '../../harness/plugin-ecosystem/tools/web-search-types.js';
import { fetchJson } from './http.js';

export interface SerperProviderConfig {
  apiKey: string;
  baseUrl?: string;
  id?: string;
  timeoutMs?: number;
}

interface SerperOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
  position?: number;
}

interface SerperApiResponse {
  searchParameters?: { q?: string };
  organic?: SerperOrganicResult[];
  searchInformation?: { totalResults?: number };
}

export function createSerperProvider(config: SerperProviderConfig): WebSearchProvider {
  if (!config.apiKey) {
    throw new Error('Serper provider requires apiKey');
  }

  const id = config.id ?? 'serper';
  const baseUrl = (config.baseUrl ?? 'https://google.serper.dev').replace(/\/$/, '');
  const timeoutMs = config.timeoutMs ?? 15_000;

  return {
    id,
    name: 'Serper (Google)',
    async search(query: string, options?: WebSearchOptions): Promise<WebSearchResponse> {
      const limit = Math.min(Math.max(options?.limit ?? 5, 1), 20);

      const body: Record<string, unknown> = {
        q: query,
        num: limit,
      };
      if (options?.region) {
        // Serper 使用 gl=US&hl=en 形式，region 形如 "us-en" / "cn-zh"
        const [gl, hl] = options.region.split('-');
        if (gl) body.gl = gl.toUpperCase();
        if (hl) body.hl = hl;
      }

      const data = await fetchJson<SerperApiResponse>(`${baseUrl}/search`, {
        method: 'POST',
        headers: {
          'X-API-KEY': config.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        timeoutMs,
        signal: options?.signal,
      });

      const results: WebSearchResultItem[] = (data.organic ?? [])
        .filter((r) => r.link && r.title)
        .slice(0, limit)
        .map((r, i) => ({
          title: r.title!,
          url: r.link!,
          snippet: r.snippet ?? '',
          publishedAt: r.date,
          rank: r.position ?? i + 1,
        }));

      return {
        query: data.searchParameters?.q ?? query,
        provider: id,
        results,
        total: data.searchInformation?.totalResults,
      };
    },
  };
}
