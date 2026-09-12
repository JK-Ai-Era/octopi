/**
 * DuckDuckGo Web Search Provider
 *
 * 免 API Key。通过 HTML 端点解析结果（无官方开放 Search API）。
 * 适合默认兜底；生产环境建议配置 Tavily/Brave/Serper 等。
 */

import type { WebSearchProvider, WebSearchOptions, WebSearchResponse, WebSearchResultItem } from '../../core/interfaces/web-search.js';
import { fetchText } from './http.js';

export interface DuckDuckGoProviderConfig {
  id?: string;
  timeoutMs?: number;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function extractResults(html: string, limit: number): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = [];

  // HTML 端点结果块：class="result results_links results_links_deep web-result"
  const blocks = html.split(/class="result results_links/).slice(1);

  for (const block of blocks) {
    if (results.length >= limit) break;

    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;

    const href = titleMatch[1] ?? '';
    const title = decodeHtmlEntities(titleMatch[2]!.replace(/<[^>]+>/g, '').trim());

    // DuckDuckGo 会把真实 URL 包在 //duckduckgo.com/l/?uddg=<encoded>
    let url = href;
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg?.[1]) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch {
        // 保留原始 href
      }
    }
    if (!url.startsWith('http')) continue;

    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/);
    const snippet = decodeHtmlEntities((snippetMatch?.[1] ?? '').replace(/<[^>]+>/g, '').trim());

    if (!title || !url) continue;

    results.push({
      title,
      url,
      snippet,
      rank: results.length + 1,
    });
  }

  return results;
}

export function createDuckDuckGoProvider(config: DuckDuckGoProviderConfig = {}): WebSearchProvider {
  const id = config.id ?? 'duckduckgo';
  const timeoutMs = config.timeoutMs ?? 15_000;

  return {
    id,
    name: 'DuckDuckGo',
    async search(query: string, options?: WebSearchOptions): Promise<WebSearchResponse> {
      const limit = Math.min(Math.max(options?.limit ?? 5, 1), 20);
      const params = new URLSearchParams({ q: query });

      // HTML 端点对 region 支持有限，通过 kl 传递
      if (options?.region) {
        params.set('kl', options.region);
      }
      const safe = options?.safeSearch;
      if (safe === 'strict') params.set('kp', '1');
      else if (safe === 'moderate') params.set('kp', '1');
      else if (safe === 'off') params.set('kp', '-1');

      const html = await fetchText(`https://html.duckduckgo.com/html/?${params.toString()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (compatible; octopi-web-search/1.0)',
        },
        timeoutMs,
        signal: options?.signal,
      });

      const results = extractResults(html, limit);
      if (results.length === 0) {
        // HTML 端点常被反爬/改版导致解析为空；显式失败以便 fallback 链切换
        const hint = html.length === 0
          ? 'empty response body'
          : html.includes('anomaly') || html.toLowerCase().includes('captcha')
            ? 'possible bot challenge / captcha'
            : `unrecognized HTML layout (${html.length} bytes)`;
        throw new Error(`DuckDuckGo returned no parseable results: ${hint}`);
      }

      return {
        query,
        provider: id,
        results,
      };
    },
  };
}
