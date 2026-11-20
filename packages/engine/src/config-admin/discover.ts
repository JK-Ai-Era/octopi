/**
 * 模型清单拉取式发现（arch/config-hot-reload.md §5.1，P1）
 *
 * 连通测试 = 拉取模型列表：成功即证明 baseUrl/key 有效，顺手填充表单清单。
 * openai-completions → `GET {baseUrl}/models`（Bearer）；
 * anthropic-messages → `GET {baseUrl}/v1/models`（x-api-key + anthropic-version）。
 *
 * **`/models` 不是 OpenAI 兼容面的必有路由**：Mistral 的官方 OpenAI 端点
 * （`https://api.mistral.ai/openai/v1`）与 Gemini 的兼容端点都只提供
 * `chat/completions`，`/models` 返回 404。此时不能把「路由缺失」判成
 * 「baseUrl / key 无效」——若调用方给了 `probeModel`，回退到一次最小对话
 * 请求（`max_tokens: 1`）验证连通，并把结果标记为 `degraded`，
 * 让 UI 如实告知「模型清单拉不到，但连通已确认」。
 *
 * @module
 */

/** 发现请求 */
export interface DiscoverModelsRequest {
  baseUrl: string;
  apiKey: string;
  api: 'openai-completions' | 'anthropic-messages';
  /** 超时（毫秒），缺省 10s */
  timeoutMs?: number;
  /**
   * `/models` 路由缺失（404）时用于最小对话探针的模型 id。
   * 缺省则不做回退，直接把 404 作为失败返回（无模型可探）。
   */
  probeModel?: string;
}

/** 发现结果（失败不抛错：UI 需要展示原因） */
export interface DiscoverModelsResult {
  ok: boolean;
  /** 发现的模型 id 清单（ok=false 时为空；degraded 时为探针模型本身） */
  models: Array<{ id: string; name?: string }>;
  /** 失败原因（ok=true 时 undefined） */
  error?: string;
  /**
   * 连通已确认但清单拿不全：厂商端点没有 `/models` 路由，仅用最小对话请求验证。
   * 调用方应据此提示用户手填模型参数，而不是当作完整清单使用。
   */
  degraded?: boolean;
  /** degraded 时的人类可读说明 */
  note?: string;
}

/** 最小对话探针的结果 */
type ChatProbeOutcome =
  | { kind: 'ok' }
  | { kind: 'auth'; status: number }
  | { kind: 'error'; status: number };

/**
 * 用一次最小对话请求验证 baseUrl/key（`/models` 缺失时的回退路径）
 *
 * @param base - 已去掉尾斜杠的 baseUrl
 * @param apiKey - 明文 key（空串则不带 Authorization）
 * @param model - 探针模型 id
 * @param timeoutMs - 超时（毫秒）
 * @returns 探针结论（ok / 鉴权失败 / 其它错误），网络异常归入 error(0)
 */
async function probeChat(
  base: string,
  apiKey: string,
  model: string,
  timeoutMs: number,
): Promise<ChatProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (res.ok) return { kind: 'ok' };
    if (res.status === 401 || res.status === 403) return { kind: 'auth', status: res.status };
    return { kind: 'error', status: res.status };
  } catch {
    // 网络层异常（DNS / TLS / abort）与 HTTP 错误在调用方都归为「不可用」，
    // 这里只需区分「鉴权失败」与「其它」，原因由调用方拼进 error 文案。
    return { kind: 'error', status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取模型清单（连通测试同源） */
export async function discoverProviderModels(req: DiscoverModelsRequest): Promise<DiscoverModelsResult> {
  const base = req.baseUrl.replace(/\/+$/, '');
  const url = req.api === 'anthropic-messages' ? `${base}/v1/models` : `${base}/models`;
  const headers: Record<string, string> = {};
  if (req.api === 'anthropic-messages') {
    if (req.apiKey) headers['x-api-key'] = req.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (req.apiKey) {
    headers['Authorization'] = `Bearer ${req.apiKey}`;
  }

  const timeoutMs = req.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      // 404 = 该端点没有 /models 路由（不是鉴权问题）：OpenAI 兼容面不承诺它。
      // 有探针模型时改走最小对话请求，把「连通」与「清单可用」两件事分开报。
      if (res.status === 404 && req.api === 'openai-completions' && req.probeModel) {
        const probe = await probeChat(base, req.apiKey, req.probeModel, timeoutMs);
        if (probe.kind === 'ok') {
          return {
            ok: true,
            models: [{ id: req.probeModel }],
            degraded: true,
            note: `该端点无 /models 路由，已用最小对话请求（${req.probeModel}）确认连通；模型参数请手填`,
          };
        }
        return {
          ok: false,
          models: [],
          error:
            probe.kind === 'auth'
              ? `HTTP ${probe.status}（/models 404；对话探针鉴权失败，请检查 key）`
              : `HTTP ${probe.status || 'network error'}（/models 404；对话探针同样失败，请检查 baseUrl）`,
        };
      }
      return { ok: false, models: [], error: `HTTP ${res.status} ${res.statusText}` };
    }
    const body = (await res.json()) as {
      data?: Array<{ id?: string; name?: string; display_name?: string }>;
      models?: Array<{ id?: string; name?: string; display_name?: string }>;
    };
    // openai 兼容为 { data: [...] }；anthropic 为 { models: [...] }
    const items = body.data ?? body.models ?? [];
    const models = items
      .filter((m) => typeof m?.id === 'string' && m.id.length > 0)
      .map((m) => ({ id: m.id as string, name: m.name ?? m.display_name }));
    return { ok: true, models };
  } catch (err) {
    return {
      ok: false,
      models: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
