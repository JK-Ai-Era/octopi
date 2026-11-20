/**
 * 模型清单拉取式发现（arch/config-hot-reload.md §5.1，P1）
 *
 * 首选免费路径：`GET {base}/models`（openai-completions）/ `GET {base}/v1/models`
 * （anthropic-messages，x-api-key + anthropic-version）。
 *
 * **`/models` 不是任何兼容面的承诺路由**，且缺失时状态码不可靠：
 * - MiMo 的 Anthropic 端点（`https://api.xiaomimimo.com/anthropic`）没有
 *   `/v1/models` → 404；
 * - 火山方舟（`https://ark.cn-beijing.volces.com/api/plan`）**先鉴权后路由**，
 *   任何路径未带 key 都是 401，无论路由是否存在 → 401 不能直接判成「key 无效」。
 *
 * 因此模型清单拿不到时（非 2xx），只要调用方给了 `probeModel`，就用一次最小对话
 * 请求（`max_tokens: 1`）判定真实连通性，把「清单可用」与「端点+鉴权可用」两件事
 * 分开报：对话成功 → `ok: true` + `degraded: true`；对话 401/403 → 真鉴权失败。
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
   * 模型清单拉不到时用于最小对话探针的模型 id。
   * 缺省则不做回退，原样返回清单请求的失败（无模型可探）。
   */
  probeModel?: string;
  /**
   * 调用方已配置的模型清单：degraded 结果回填它，
   * 让 UI 拿到「已配置的模型」而不是只有探针那一条。
   */
  knownModels?: Array<{ id: string; name?: string }>;
}

/** 发现结果（失败不抛错：UI 需要展示原因） */
export interface DiscoverModelsResult {
  ok: boolean;
  /** 发现的模型 id 清单（ok=false 时为空；degraded 时为已知清单或探针模型） */
  models: Array<{ id: string; name?: string }>;
  /** 失败原因（ok=true 时 undefined） */
  error?: string;
  /**
   * 连通已确认但清单拉不到：端点没有 `/models` 路由（或该路由受网关策略拦截），
   * 仅用最小对话请求验证过端点与鉴权。调用方应提示用户手填模型参数。
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

/** 各协议的最小对话请求形态 */
function buildProbeRequest(
  api: DiscoverModelsRequest['api'],
  base: string,
  apiKey: string,
  model: string,
): { url: string; headers: Record<string, string>; body: string } {
  if (api === 'anthropic-messages') {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (apiKey) headers['x-api-key'] = apiKey;
    return {
      url: `${base}/v1/messages`,
      headers,
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    };
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return {
    url: `${base}/chat/completions`,
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    }),
  };
}

/**
 * 用一次最小对话请求验证 baseUrl/key
 *
 * @param api - 协议（决定路径与鉴权头）
 * @param base - 已去掉尾斜杠的 baseUrl
 * @param apiKey - 明文 key（空串则不带鉴权头）
 * @param model - 探针模型 id
 * @param timeoutMs - 超时（毫秒）
 * @returns 探针结论；400/422 视为连通成立（鉴权已过，只是请求本身被模型层拒绝）
 */
async function probeChat(
  api: DiscoverModelsRequest['api'],
  base: string,
  apiKey: string,
  model: string,
  timeoutMs: number,
): Promise<ChatProbeOutcome> {
  const { url, headers, body } = buildProbeRequest(api, base, apiKey, model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    if (res.status === 401 || res.status === 403) return { kind: 'auth', status: res.status };
    // 400 / 422 = 鉴权与路由都通，只是请求内容（如模型名）被拒；连通成立。
    if (res.ok || res.status === 400 || res.status === 422) return { kind: 'ok' };
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
  const isAnthropic = req.api === 'anthropic-messages';
  const url = isAnthropic ? `${base}/v1/models` : `${base}/models`;
  const headers: Record<string, string> = {};
  if (isAnthropic) {
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
      // 只有状态码有歧义时才回退：404 缺路由、401/403 可能是网关先鉴权后路由、
      // 405 是不允许该方法。5xx / 429 是端点自身状态，照实报，不拿探针掩盖。
      const ambiguous = res.status === 404 || res.status === 401
        || res.status === 403 || res.status === 405;
      if (ambiguous && req.probeModel) {
        const probe = await probeChat(req.api, base, req.apiKey, req.probeModel, timeoutMs);
        if (probe.kind === 'ok') {
          const known = req.knownModels?.length ? req.knownModels : [{ id: req.probeModel }];
          return {
            ok: true,
            models: known,
            degraded: true,
            note: `该端点未提供模型清单接口（${url} 返回 HTTP ${res.status}），已用最小对话请求（${req.probeModel}）确认端点与鉴权可用；模型参数请以官方文档为准`,
          };
        }
        return {
          ok: false,
          models: [],
          error:
            probe.kind === 'auth'
              ? `HTTP ${probe.status}（清单接口 ${res.status}；对话探针鉴权失败，请检查 key 与 baseUrl 所属区域）`
              : `HTTP ${probe.status || 'network error'}（清单接口 ${res.status}；对话探针同样失败，请检查 baseUrl）`,
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
