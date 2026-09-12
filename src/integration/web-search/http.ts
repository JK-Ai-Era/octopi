/**
 * Web Search HTTP 请求辅助
 *
 * 统一 timeout / abort / JSON 错误处理。
 */

export async function fetchJson<T>(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Web search timed out after ${timeoutMs}ms`)), timeoutMs);

  const onAbort = () => controller.abort(init.signal?.reason);
  if (init.signal) {
    if (init.signal.aborted) controller.abort(init.signal.reason);
    else init.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Web search HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Web search returned non-JSON response (status ${response.status})`);
    }
  } finally {
    clearTimeout(timer);
    if (init.signal) init.signal.removeEventListener('abort', onAbort);
  }
}

export async function fetchText(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const timeoutMs = init.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Web search timed out after ${timeoutMs}ms`)), timeoutMs);

  const onAbort = () => controller.abort(init.signal?.reason);
  if (init.signal) {
    if (init.signal.aborted) controller.abort(init.signal.reason);
    else init.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Web search HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
    if (init.signal) init.signal.removeEventListener('abort', onAbort);
  }
}

/** 将 safeSearch 映射为常见枚举 */
export function normalizeSafeSearch(value?: string): string | undefined {
  if (!value) return undefined;
  if (value === 'off') return 'off';
  if (value === 'strict') return 'strict';
  return 'moderate';
}

/** 将 timeRange 映射为天数（部分 API 用 days） */
export function timeRangeToDays(timeRange?: 'day' | 'week' | 'month' | 'year'): number | undefined {
  switch (timeRange) {
    case 'day':
      return 1;
    case 'week':
      return 7;
    case 'month':
      return 31;
    case 'year':
      return 365;
    default:
      return undefined;
  }
}
