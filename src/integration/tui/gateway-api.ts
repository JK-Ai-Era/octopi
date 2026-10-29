/**
 * TUI 侧 Gateway REST 客户端（/api/v1）。
 *
 * WS 之外的辅助面：会话列表与历史消息（/sessions、/resume 的数据源）。
 * 鉴权与 WS 同一凭据——channels.http.apiKey，经 Authorization: Bearer 携带；
 * 未配置 apiKey 的部署不带该头（无鉴权模式）。
 */

import type { Message } from '@octopi-agent/core/types/messages.js';
import type { SessionMeta } from '@octopi-agent/core/types/session.js';

/** 会话列表项 = SessionMeta + 运行态投影（listSessions 口径） */
export type TuiSessionItem = SessionMeta & { running: boolean };

/** 历史消息页（getSessionMessages 口径） */
export interface TuiHistoryPage {
  messages: Array<Message & { index: number }>;
  nextCursor?: string;
  total: number;
  hasMore: boolean;
}

export interface TuiGatewayApiOptions {
  /** Gateway 基址（如 http://localhost:18180） */
  baseUrl: string;
  /** Gateway apiKey（channels.http.apiKey）；缺省不带 Authorization 头 */
  apiKey?: string;
  /** fetch 实现（测试注入用；缺省全局 fetch） */
  fetchImpl?: typeof fetch;
}

/** GET /api/v1&lt;path&gt; 的统一信封解析：{ ok, data } / { ok:false, error } */
async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<T> {
  const res = await fetchImpl(url, { headers });
  let body: { ok?: boolean; data?: T; error?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new Error(`Gateway 返回非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok || body.ok === false) {
    throw new Error(body.error ?? `Gateway HTTP ${res.status}`);
  }
  return body.data as T;
}

export class TuiGatewayApi {
  private baseUrl: string;
  private apiKey?: string;
  private fetchImpl: typeof fetch;

  constructor(options: TuiGatewayApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  /**
   * 会话列表（可按 agent 过滤）。
   *
   * @param agentId - 缺省返回全部 agent 的会话
   * @returns 列表项（meta + running 投影），顺序由 Gateway 决定
   */
  async listSessions(agentId?: string): Promise<TuiSessionItem[]> {
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    return requestJson<TuiSessionItem[]>(
      this.fetchImpl,
      `${this.baseUrl}/api/v1/sessions${query}`,
      this.headers(),
    );
  }

  /**
   * 会话历史消息（分页）。
   *
   * @param sessionId - 目标会话
   * @param options - limit（≤200）/ cursor / direction（backward=从末尾取页，缺省）
   * @returns 消息页（含 index 与 nextCursor）
   */
  async getSessionMessages(
    sessionId: string,
    options?: { limit?: number; cursor?: string; direction?: 'forward' | 'backward' },
  ): Promise<TuiHistoryPage> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.cursor) params.set('cursor', options.cursor);
    if (options?.direction) params.set('direction', options.direction);
    const query = params.toString() ? `?${params.toString()}` : '';
    return requestJson<TuiHistoryPage>(
      this.fetchImpl,
      `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages${query}`,
      this.headers(),
    );
  }
}
