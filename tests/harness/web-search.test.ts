/**
 * web_search 工具与 provider 测试
 *
 * 覆盖：
 * - createWebSearchTool 参数映射与结果归一化
 * - createWebSearchWithFallback 降级链
 * - resolveWebSearchProviders 配置解析
 * - DuckDuckGo HTML 结果解析
 * - Tavily / Brave / Serper 请求映射（mock fetch）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { WebSearchProvider, WebSearchResponse } from '../../harness/plugin-ecosystem/tools/web-search-types.js';
import { createWebSearchTool } from '../../src/harness/plugin-ecosystem/tools/web-search.js';
import {
  createWebSearchProviderFromSlot,
  resolveWebSearchProviders,
  createWebSearchWithFallback,
} from '../../src/integration/web-search/factory.js';
import { createDuckDuckGoProvider } from '../../src/integration/web-search/duckduckgo.js';
import { createTavilyProvider } from '../../src/integration/web-search/tavily.js';
import { createBraveProvider } from '../../src/integration/web-search/brave.js';
import { createSerperProvider } from '../../src/integration/web-search/serper.js';
import { createMimoProvider } from '../../src/integration/web-search/mimo.js';
import { createToolSet } from '../../src/harness/plugin-ecosystem/tools/tool-set.js';
import type { ToolExecutionContext } from '../../src/core/types/tools.js';

function makeContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    sessionId: 's1',
    agentId: 'a1',
    messages: [],
    ...overrides,
  };
}

function makeProvider(overrides: Partial<WebSearchProvider> = {}): WebSearchProvider {
  return {
    id: 'mock',
    name: 'Mock',
    search: vi.fn(async (): Promise<WebSearchResponse> => ({
      query: 'q',
      provider: 'mock',
      results: [
        { title: 'T1', url: 'https://a.example', snippet: 'S1', rank: 1 },
        { title: 'T2', url: 'https://b.example', snippet: 'S2', rank: 2 },
      ],
    })),
    ...overrides,
  };
}

// ── createWebSearchTool ──

describe('createWebSearchTool', () => {
  it('should expose expected definition metadata', () => {
    const tool = createWebSearchTool(makeProvider());
    expect(tool.definition.name).toBe('web_search');
    expect(tool.definition.parameters.query?.required).toBe(true);
    expect(tool.definition.timeoutMs).toBe(90_000);
    expect(tool.source?.origin).toBe('web-search');
  });

  it('should map tool args to search options', async () => {
    const provider = makeProvider();
    const tool = createWebSearchTool(provider, { defaultLimit: 3, timeoutMs: 10_000 });

    await tool.handler(
      {
        query: '  octopi agent  ',
        limit: 2,
        region: 'cn-zh',
        safe_search: 'strict',
        time_range: 'week',
      },
      makeContext(),
    );

    expect(provider.search).toHaveBeenCalledWith('octopi agent', {
      limit: 2,
      region: 'cn-zh',
      safeSearch: 'strict',
      timeRange: 'week',
      signal: undefined,
    });
  });

  it('should clamp limit to max 20', async () => {
    const provider = makeProvider();
    const tool = createWebSearchTool(provider);

    await tool.handler({ query: 'x', limit: 99 }, makeContext());
    expect(provider.search).toHaveBeenCalledWith(
      'x',
      expect.objectContaining({ limit: 20 }),
    );
  });

  it('should reject empty query', async () => {
    const tool = createWebSearchTool(makeProvider());
    await expect(tool.handler({ query: '   ' }, makeContext())).rejects.toThrow(/non-empty query/);
  });

  it('should return normalized response shape', async () => {
    const tool = createWebSearchTool(makeProvider(), {
      availableProviders: ['mock', 'other'],
    });
    const result = await tool.handler({ query: 'hello' }, makeContext()) as any;

    expect(result.provider).toBe('mock');
    expect(result.results).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.availableProviders).toEqual(['mock', 'other']);
  });
});

// ── Fallback ──

describe('createWebSearchWithFallback', () => {
  it('should use primary when it succeeds', async () => {
    const primary = makeProvider({ id: 'p' });
    const fallback = makeProvider({ id: 'f' });
    const chained = createWebSearchWithFallback(primary, [fallback]);

    const res = await chained.search('q');
    expect(res.provider).toBe('mock');
    expect(primary.search).toHaveBeenCalled();
    expect(fallback.search).not.toHaveBeenCalled();
  });

  it('should fall through to next provider on failure', async () => {
    const primary: WebSearchProvider = {
      id: 'p',
      name: 'Primary',
      search: vi.fn(async () => {
        throw new Error('primary down');
      }),
    };
    const fallback = makeProvider({ id: 'f', name: 'Fallback' });
    const chained = createWebSearchWithFallback(primary, [fallback]);

    const res = await chained.search('q');
    expect(res.provider).toBe('mock');
    expect(primary.search).toHaveBeenCalled();
    expect(fallback.search).toHaveBeenCalled();
  });

  it('should fall through when primary returns empty results', async () => {
    const primary = makeProvider({
      id: 'empty-primary',
      search: vi.fn(async () => ({
        query: 'q',
        provider: 'empty-primary',
        results: [],
      })),
    });
    const fallback = makeProvider({
      id: 'good-fallback',
      search: vi.fn(async () => ({
        query: 'q',
        provider: 'good-fallback',
        results: [{ title: 'T', url: 'https://t.test', snippet: 's', rank: 1 }],
      })),
    });
    const chained = createWebSearchWithFallback(primary, [fallback]);

    const res = await chained.search('q');
    expect(res.provider).toBe('good-fallback');
    expect(res.results).toHaveLength(1);
    expect(primary.search).toHaveBeenCalled();
    expect(fallback.search).toHaveBeenCalled();
  });

  it('should return last empty response when all providers return empty', async () => {
    const empty = (id: string): WebSearchProvider => ({
      id,
      name: id,
      search: async () => ({ query: 'q', provider: id, results: [] }),
    });
    const chained = createWebSearchWithFallback(empty('a'), [empty('b')]);

    const res = await chained.search('q');
    expect(res.provider).toBe('b');
    expect(res.results).toHaveLength(0);
  });

  it('should aggregate errors when all fail', async () => {
    const p1: WebSearchProvider = {
      id: 'p1',
      name: 'P1',
      search: async () => {
        throw new Error('e1');
      },
    };
    const p2: WebSearchProvider = {
      id: 'p2',
      name: 'P2',
      search: async () => {
        throw new Error('e2');
      },
    };
    const chained = createWebSearchWithFallback(p1, [p2]);

    await expect(chained.search('q')).rejects.toThrow(/p1: e1; p2: e2/);
  });
});

// ── resolveWebSearchProviders ──

describe('resolveWebSearchProviders', () => {
  it('should return empty primary when providers is empty', () => {
    const resolved = resolveWebSearchProviders({});
    expect(resolved.primary).toBeUndefined();
    expect(resolved.fallbacks).toHaveLength(0);
  });

  it('should pick first key when provider is omitted', () => {
    const resolved = resolveWebSearchProviders({
      providers: {
        ddg: { api: 'duckduckgo' },
      },
    });
    expect(resolved.primary?.id).toBe('ddg');
  });

  it('should respect explicit provider and fallbacks', () => {
    const resolved = resolveWebSearchProviders({
      provider: 'tavily-main',
      fallbacks: ['ddg'],
      providers: {
        'tavily-main': { api: 'tavily', apiKey: 'tvly-key' },
        ddg: { api: 'duckduckgo' },
      },
    });
    expect(resolved.primary?.id).toBe('tavily-main');
    expect(resolved.fallbacks.map((f) => f.id)).toEqual(['ddg']);
  });

  it('should auto-append duckduckgo when no fallbacks configured and primary is not ddg', () => {
    const resolved = resolveWebSearchProviders({
      providers: {
        tavily: { api: 'tavily', apiKey: 'k' },
      },
    });
    expect(resolved.primary?.id).toBe('tavily');
    expect(resolved.fallbacks.map((f) => f.id)).toEqual(['duckduckgo']);
  });

  it('should not auto-append duckduckgo when primary api is already duckduckgo under another key', () => {
    const resolved = resolveWebSearchProviders({
      providers: {
        free: { api: 'duckduckgo' },
      },
    });
    expect(resolved.fallbacks).toHaveLength(0);
  });

  it('should raise tool timeout when primary is mimo', () => {
    const resolved = resolveWebSearchProviders({
      provider: 'mimo',
      fallbacks: ['ddg'],
      timeoutMs: 15_000,
      providers: {
        mimo: { api: 'mimo', apiKey: 'k' },
        ddg: { api: 'duckduckgo' },
      },
    });
    expect(resolved.timeoutMs).toBe(90_000);
  });

  it('should skip unknown fallback keys', () => {
    const resolved = resolveWebSearchProviders({
      provider: 'a',
      fallbacks: ['missing', 'b'],
      providers: {
        a: { api: 'duckduckgo' },
        b: { api: 'duckduckgo' },
      },
    });
    expect(resolved.fallbacks.map((f) => f.id)).toEqual(['b']);
  });
});

// ── createWebSearchProviderFromSlot ──

describe('createWebSearchProviderFromSlot', () => {
  it('should create providers by api type', () => {
    expect(createWebSearchProviderFromSlot('k', { api: 'duckduckgo' }).id).toBe('k');
    expect(createWebSearchProviderFromSlot('t', { api: 'tavily', apiKey: 'x' }).id).toBe('t');
    expect(createWebSearchProviderFromSlot('b', { api: 'brave', apiKey: 'x' }).id).toBe('b');
    expect(createWebSearchProviderFromSlot('s', { api: 'serper', apiKey: 'x' }).id).toBe('s');
    expect(createWebSearchProviderFromSlot('m', { api: 'mimo', apiKey: 'x' }).id).toBe('m');
  });

  it('should throw when key-based provider requires apiKey but missing', () => {
    expect(() => createWebSearchProviderFromSlot('t', { api: 'tavily' })).toThrow(/apiKey/);
    expect(() => createWebSearchProviderFromSlot('b', { api: 'brave' })).toThrow(/apiKey/);
    expect(() => createWebSearchProviderFromSlot('s', { api: 'serper' })).toThrow(/apiKey/);
    expect(() => createWebSearchProviderFromSlot('m', { api: 'mimo' })).toThrow(/apiKey/);
  });
});

// ── createToolSet integration ──

describe('createToolSet with webSearch', () => {
  it('should include web_search only when webSearch is provided', () => {
    const without = createToolSet();
    expect(without.all.map((t) => t.definition.name)).not.toContain('web_search');

    const withSearch = createToolSet({
      webSearch: { provider: makeProvider(), defaultLimit: 3 },
    });
    const names = withSearch.all.map((t) => t.definition.name);
    expect(names).toContain('web_search');
  });
});

// ── HTTP provider mapping (mock fetch) ──

const originalFetch = globalThis.fetch;

function mockFetchOnce(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Tavily provider', () => {
  it('should map request and normalize results', async () => {
    mockFetchOnce(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.query).toBe('agent frameworks');
      expect(body.max_results).toBe(2);
      expect(body.api_key).toBe('tvly-test');
      return new Response(
        JSON.stringify({
          query: 'agent frameworks',
          results: [
            { title: 'A', url: 'https://a.test', content: 'ca', published_date: '2026-01-01' },
            { title: 'B', url: 'https://b.test', content: 'cb' },
            { url: 'https://no-title.test', content: 'x' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const provider = createTavilyProvider({ apiKey: 'tvly-test' });
    const res = await provider.search('agent frameworks', { limit: 2, timeRange: 'day' });

    expect(res.provider).toBe('tavily');
    expect(res.results).toHaveLength(2);
    expect(res.results[0]).toMatchObject({
      title: 'A',
      url: 'https://a.test',
      snippet: 'ca',
      rank: 1,
    });
  });

  it('should surface HTTP errors', async () => {
    mockFetchOnce(async () => new Response('bad key', { status: 401 }));
    const provider = createTavilyProvider({ apiKey: 'x' });
    await expect(provider.search('q')).rejects.toThrow(/HTTP 401/);
  });
});

describe('Brave provider', () => {
  it('should send subscription token and map web results', async () => {
    mockFetchOnce(async (url, init) => {
      expect(url).toContain('api.search.brave.com/res/v1/web/search');
      expect((init?.headers as Record<string, string>)['X-Subscription-Token']).toBe('brave-key');
      expect(url).toContain('q=hello');
      return new Response(
        JSON.stringify({
          query: { original: 'hello' },
          web: {
            total: 10,
            results: [
              { title: 'Brave A', url: 'https://brave.test/a', description: 'da', page_age: '2026-02-01' },
            ],
          },
        }),
        { status: 200 },
      );
    });

    const provider = createBraveProvider({ apiKey: 'brave-key' });
    const res = await provider.search('hello', { limit: 5, region: 'us-en', safeSearch: 'moderate' });

    expect(res.provider).toBe('brave');
    expect(res.total).toBe(10);
    expect(res.results[0]).toMatchObject({
      title: 'Brave A',
      url: 'https://brave.test/a',
      snippet: 'da',
      publishedAt: '2026-02-01',
    });
  });
});

describe('Serper provider', () => {
  it('should POST with X-API-KEY and map organic results', async () => {
    mockFetchOnce(async (url, init) => {
      expect(url).toContain('google.serper.dev/search');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['X-API-KEY']).toBe('serper-key');
      const body = JSON.parse(String(init?.body));
      expect(body.q).toBe('typescript');
      expect(body.gl).toBe('US');
      expect(body.hl).toBe('en');
      return new Response(
        JSON.stringify({
          searchParameters: { q: 'typescript' },
          organic: [
            { title: 'TS', link: 'https://ts.test', snippet: 's', position: 1, date: '2026-03-01' },
          ],
          searchInformation: { totalResults: 123 },
        }),
        { status: 200 },
      );
    });

    const provider = createSerperProvider({ apiKey: 'serper-key' });
    const res = await provider.search('typescript', { region: 'us-en' });

    expect(res.provider).toBe('serper');
    expect(res.total).toBe(123);
    expect(res.results[0]).toMatchObject({
      title: 'TS',
      url: 'https://ts.test',
      snippet: 's',
      publishedAt: '2026-03-01',
      rank: 1,
    });
  });
});

describe('DuckDuckGo provider', () => {
  it('should parse html endpoint results and unwrap uddg links', async () => {
    const html = `
      <div class="result results_links results_links_deep web-result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=x">Example <b>Page</b></a>
        <a class="result__snippet">A short snippet</a>
      </div>
      <div class="result results_links results_links_deep web-result">
        <a class="result__a" href="https://direct.test/x">Direct</a>
        <div class="result__snippet">Direct snippet</div>
      </div>
    `;
    mockFetchOnce(async () => new Response(html, { status: 200 }));

    const provider = createDuckDuckGoProvider();
    const res = await provider.search('example', { limit: 5, region: 'cn-zh' });

    expect(res.provider).toBe('duckduckgo');
    expect(res.results).toHaveLength(2);
    expect(res.results[0]).toMatchObject({
      title: 'Example Page',
      url: 'https://example.com/page',
      snippet: 'A short snippet',
      rank: 1,
    });
    expect(res.results[1]?.url).toBe('https://direct.test/x');
  });

  it('should throw when HTML is unparseable so fallback can continue', async () => {
    mockFetchOnce(async () => new Response('<html><body>blocked</body></html>', { status: 200 }));
    const provider = createDuckDuckGoProvider();
    await expect(provider.search('anything')).rejects.toThrow(/no parseable results/);
  });
});

describe('MiMo provider', () => {
  it('should require apiKey', () => {
    expect(() => createMimoProvider({ apiKey: '' })).toThrow(/apiKey/);
  });

  it('should retry once on timeout then succeed', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('Web search timed out after 90000ms');
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'ok',
                annotations: [{ type: 'url_citation', title: 'A', url: 'https://a.test', summary: 's' }],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const provider = createMimoProvider({ apiKey: 'k' });
    const res = await provider.search('q');
    expect(res.results).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('should send official web_search tool shape and map url_citation annotations', async () => {
    mockFetchOnce(async (url, init) => {
      expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer mimo-key');
      expect(headers['api-key']).toBe('mimo-key');

      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('mimo-v2.5-pro');
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.stream).toBe(false);
      expect(body.tools).toEqual([
        {
          type: 'web_search',
          max_keyword: 3,
          force_search: true,
          limit: 2,
        },
      ]);
      expect(body.messages[1].content).toBe('please introduce Jun Lei');

      return new Response(
        JSON.stringify({
          id: '828d5db56ff748d8b4623d1972c8eca2',
          choices: [
            {
              finish_reason: 'stop',
              index: 0,
              message: {
                role: 'assistant',
                content: 'Based on the search results, here is an introduction to Jun Lei.',
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://en.shunwei.com/team',
                    title: 'Team – Shunwei',
                    summary: 'Jun LEI Founding Partner & Chairman Mr. Lei Jun',
                    site_name: 'en.shunwei.com',
                    publish_time: '2024-10-26T07:37:04+08:00',
                    logo_url: 'https://th.bochaai.com/favicon?domain_url=https://en.shunwei.com/team',
                  },
                  {
                    type: 'url_citation',
                    url: 'https://max.book118.com/html/2023/0519/7145010064005110.shtm',
                    title: '小米公司介绍',
                    summary: '小米创始人:雷军',
                    site_name: '原创力文档',
                    publish_time: '2023-05-23T19:49:37+08:00',
                  },
                  {
                    // 非 http url，应被过滤
                    type: 'url_citation',
                    title: 'invalid',
                    url: 'ftp://bad',
                    summary: 'x',
                  },
                ],
              },
            },
          ],
          usage: {
            completion_tokens: 387,
            prompt_tokens: 1222,
            total_tokens: 1609,
            web_search_usage: { tool_usage: 3, page_usage: 2 },
          },
        }),
        { status: 200 },
      );
    });

    const provider = createMimoProvider({ apiKey: 'mimo-key' });
    const res = await provider.search('please introduce Jun Lei', { limit: 2 });

    expect(res.provider).toBe('mimo');
    expect(res.results).toHaveLength(2);
    expect(res.results[0]).toMatchObject({
      title: 'Team – Shunwei',
      url: 'https://en.shunwei.com/team',
      snippet: 'Jun LEI Founding Partner & Chairman Mr. Lei Jun',
      publishedAt: '2024-10-26T07:37:04+08:00',
      rank: 1,
    });
    expect(res.total).toBe(2);
    expect(res.answer).toContain('Jun Lei');
  });

  it('should map limit / force_search / max_keyword / user_location from options and config', async () => {
    let capturedBody: any;
    mockFetchOnce(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'ok',
                annotations: [{ type: 'url_citation', title: 'A', url: 'https://a.test', summary: 'sa' }],
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const provider = createMimoProvider({
      apiKey: 'k',
      maxKeyword: 5,
      forceSearch: false,
      userLocation: { country: 'China', region: 'Hubei', city: 'Wuhan' },
    });

    await provider.search('q', { limit: 7 });
    expect(capturedBody.tools[0]).toEqual({
      type: 'web_search',
      max_keyword: 5,
      force_search: false,
      limit: 7,
      user_location: {
        type: 'approximate',
        country: 'China',
        region: 'Hubei',
        city: 'Wuhan',
      },
    });

    // region 参数覆盖配置位置
    await provider.search('q', { limit: 1, region: 'US-California-San Francisco' });
    expect(capturedBody.tools[0].user_location).toEqual({
      type: 'approximate',
      country: 'US',
      region: 'California',
      city: 'San Francisco',
    });
  });

  it('should fall back to content JSON when annotations missing', async () => {
    mockFetchOnce(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '```json\n[{"title":"From Content","url":"https://c.test","snippet":"sc"}]\n```',
                annotations: [],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = createMimoProvider({ apiKey: 'k' });
    const res = await provider.search('q');
    expect(res.results).toHaveLength(1);
    expect(res.results[0]).toMatchObject({
      title: 'From Content',
      url: 'https://c.test',
      snippet: 'sc',
    });
  });

  it('should surface error_message from response', async () => {
    mockFetchOnce(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '',
                error_message: 'web search plugin not enabled',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = createMimoProvider({ apiKey: 'k' });
    await expect(provider.search('q')).rejects.toThrow(/web search plugin not enabled/);
  });

  it('should respect custom model and baseUrl', async () => {
    mockFetchOnce(async (url, init) => {
      expect(url).toBe('https://proxy.example/v1/chat/completions');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('mimo-v2.5');
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok', annotations: [{ type: 'url_citation', title: 'T', url: 'https://t.test', summary: 's' }] } }],
        }),
        { status: 200 },
      );
    });

    const provider = createMimoProvider({
      apiKey: 'k',
      baseUrl: 'https://proxy.example/v1/',
      model: 'mimo-v2.5',
    });
    const res = await provider.search('q');
    expect(res.results).toHaveLength(1);
  });
});
