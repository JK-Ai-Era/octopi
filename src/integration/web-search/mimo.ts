/**
 * MiMo Web Search Provider
 *
 * 基于 Xiaomi MiMo Chat Completions 内置联网搜索 tool。
 * 文档: https://mimo.mi.com/docs/zh-CN/api/chat/openai-api
 *
 * 请求 tools 格式（官方示例）：
 * ```json
 * {
 *   "type": "web_search",
 *   "max_keyword": 3,
 *   "force_search": true,
 *   "limit": 1,
 *   "user_location": {
 *     "type": "approximate",
 *     "country": "China",
 *     "region": "Hubei",
 *     "city": "Wuhan"
 *   }
 * }
 * ```
 *
 * 响应：`choices[0].message.annotations[]`（type=url_citation）映射为搜索结果；
 *       `message.content` 作为综合摘要（answer）。
 * 鉴权同时携带 `Authorization: Bearer` 与 `api-key` 头。
 */

import type {
  WebSearchProvider,
  WebSearchOptions,
  WebSearchResponse,
  WebSearchResultItem,
} from '../../harness/plugin-ecosystem/tools/web-search-types.js';
import { fetchJson } from './http.js';

/** 用户位置（approximate） */
export interface MimoUserLocation {
  /** 国家，如 "China" */
  country?: string;
  /** 省/州，如 "Hubei" */
  region?: string;
  /** 城市，如 "Wuhan" */
  city?: string;
}

export interface MimoProviderConfig {
  /** API Key */
  apiKey: string;
  /** 默认 https://api.xiaomimimo.com/v1 */
  baseUrl?: string;
  id?: string;
  timeoutMs?: number;
  /** 默认 mimo-v2.5-pro */
  model?: string;
  /** 搜索关键词数量上限（max_keyword，默认 3） */
  maxKeyword?: number;
  /** 是否强制搜索（force_search，默认 true） */
  forceSearch?: boolean;
  /** 默认结果条数（tools.limit；每次调用的 options.limit 可覆盖） */
  defaultLimit?: number;
  /** 用户位置偏好 */
  userLocation?: MimoUserLocation;
  /** 最大补全 token（默认 4096） */
  maxCompletionTokens?: number;
}

/** 联网搜索注解（type=url_citation） */
interface MimoAnnotation {
  type?: string;
  title?: string;
  url?: string;
  summary?: string;
  site_name?: string;
  publish_time?: string;
  logo_url?: string;
}

interface MimoChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      annotations?: MimoAnnotation[] | null;
      error_message?: string | null;
      tool_calls?: unknown;
    };
  }>;
  usage?: {
    web_search_usage?: {
      tool_usage?: number;
      page_usage?: number;
    };
  };
}

function annotationsToResults(
  annotations: MimoAnnotation[],
  limit: number,
): WebSearchResultItem[] {
  return annotations
    .filter((a) => Boolean(a.url?.startsWith('http')) && Boolean(a.title))
    .slice(0, limit)
    .map((a, i) => ({
      title: a.title!,
      url: a.url!,
      snippet: a.summary ?? '',
      publishedAt: a.publish_time,
      rank: i + 1,
    }));
}

/**
 * 兜底：annotations 为空时尝试解析 content 中的 JSON 列表
 */
function tryParseContentResults(content: string, limit: number): WebSearchResultItem[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());

  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { results?: unknown }).results)
          ? (parsed as { results: unknown[] }).results
          : null;
      if (!list) continue;

      const results: WebSearchResultItem[] = [];
      for (const item of list) {
        if (results.length >= limit) break;
        if (typeof item !== 'object' || item === null) continue;
        const o = item as Record<string, unknown>;
        const url = typeof o.url === 'string' ? o.url : typeof o.link === 'string' ? o.link : undefined;
        const title = typeof o.title === 'string' ? o.title : undefined;
        if (!url || !title || !url.startsWith('http')) continue;
        const snippet =
          typeof o.snippet === 'string'
            ? o.snippet
            : typeof o.summary === 'string'
              ? o.summary
              : typeof o.content === 'string'
                ? o.content
                : '';
        results.push({
          title,
          url,
          snippet,
          publishedAt: typeof o.publishedAt === 'string' ? o.publishedAt : undefined,
          rank: results.length + 1,
        });
      }
      if (results.length > 0) return results;
    } catch {
      // not JSON — try next candidate
    }
  }
  return [];
}

/**
 * 将 WebSearchOptions.region / 配置 user_location 合成为 approximate 位置
 *
 * region 支持 "China-Hubei-Wuhan" / "CN-HB" 等简单连字符形式；
 * 未提供 region 时使用配置中的 userLocation。
 */
function resolveUserLocation(
  options: WebSearchOptions | undefined,
  configured: MimoUserLocation | undefined,
): MimoUserLocation | undefined {
  const region = options?.region?.trim();
  if (region) {
    const parts = region.split('-').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 3) {
      return { country: parts[0], region: parts[1], city: parts.slice(2).join('-') };
    }
    if (parts.length === 2) {
      return { country: parts[0], region: parts[1] };
    }
    if (parts.length === 1) {
      return { country: parts[0] };
    }
  }
  return configured;
}

export function createMimoProvider(config: MimoProviderConfig): WebSearchProvider {
  if (!config.apiKey) {
    throw new Error('MiMo provider requires apiKey');
  }

  const id = config.id ?? 'mimo';
  const baseUrl = (config.baseUrl ?? 'https://api.xiaomimimo.com/v1').replace(/\/$/, '');
  // 联网搜索会触发完整 Chat Completions，30s 经常不够
  const timeoutMs = config.timeoutMs ?? 90_000;
  const model = config.model ?? 'mimo-v2.5-pro';
  const maxKeyword = config.maxKeyword ?? 3;
  const forceSearch = config.forceSearch ?? true;
  const configuredDefaultLimit = config.defaultLimit ?? 5;
  const maxCompletionTokens = config.maxCompletionTokens ?? 4096;
  const maxAttempts = 2;

  async function searchOnce(query: string, options?: WebSearchOptions): Promise<WebSearchResponse> {
    const limit = Math.min(
      Math.max(options?.limit ?? configuredDefaultLimit, 1),
      20,
    );

    const userLocation = resolveUserLocation(options, config.userLocation);
    const webSearchTool: Record<string, unknown> = {
      type: 'web_search',
      max_keyword: maxKeyword,
      force_search: forceSearch,
      limit,
    };
    if (userLocation && (userLocation.country || userLocation.region || userLocation.city)) {
      webSearchTool.user_location = {
        type: 'approximate',
        ...(userLocation.country ? { country: userLocation.country } : {}),
        ...(userLocation.region ? { region: userLocation.region } : {}),
        ...(userLocation.city ? { city: userLocation.city } : {}),
      };
    }

    const body = {
      model,
      messages: [
        {
          role: 'system',
          content: 'You are MiMo, an AI assistant developed by Xiaomi.',
        },
        { role: 'user', content: query },
      ],
      tools: [webSearchTool],
      max_completion_tokens: maxCompletionTokens,
      temperature: 1.0,
      top_p: 0.95,
      stream: false,
      stop: null,
      frequency_penalty: 0,
      presence_penalty: 0,
      // 联网搜索由服务端完成，关闭思维链以降低延迟
      thinking: { type: 'disabled' },
    };

    const data = await fetchJson<MimoChatResponse>(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        'api-key': config.apiKey,
      },
      body: JSON.stringify(body),
      timeoutMs,
      signal: options?.signal,
    });

    const message = data.choices?.[0]?.message;
    if (message?.error_message) {
      throw new Error(`MiMo web search failed: ${message.error_message}`);
    }

    const content = message?.content ?? '';
    let results = annotationsToResults(message?.annotations ?? [], limit);
    if (results.length === 0) {
      results = tryParseContentResults(content, limit);
    }

    if (results.length === 0 && !content.trim()) {
      throw new Error('MiMo web search returned no results');
    }

    const pageUsage = data.usage?.web_search_usage?.page_usage;

    return {
      query,
      provider: id,
      results,
      total: pageUsage ?? results.length,
      answer: content.trim() || undefined,
    };
  }

  function isRetryableError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /timed out|timeout|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(message);
  }

  return {
    id,
    name: 'MiMo Web Search',
    async search(query: string, options?: WebSearchOptions): Promise<WebSearchResponse> {
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await searchOnce(query, options);
        } catch (err) {
          lastError = err;
          if (attempt < maxAttempts && isRetryableError(err) && !options?.signal?.aborted) {
            console.warn(
              `[WebSearch] mimo attempt ${attempt}/${maxAttempts} failed (${err instanceof Error ? err.message : String(err)}), retrying`,
            );
            continue;
          }
          throw err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };
}
