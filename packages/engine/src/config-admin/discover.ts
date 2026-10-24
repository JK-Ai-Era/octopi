/**
 * 模型清单拉取式发现（arch/config-hot-reload.md §5.1，P1）
 *
 * 连通测试 = 拉取模型列表：成功即证明 baseUrl/key 有效，顺手填充表单清单。
 * openai-completions → `GET {baseUrl}/models`（Bearer）；
 * anthropic-messages → `GET {baseUrl}/v1/models`（x-api-key + anthropic-version）。
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
}

/** 发现结果（失败不抛错：UI 需要展示原因） */
export interface DiscoverModelsResult {
  ok: boolean;
  /** 发现的模型 id 清单（ok=false 时为空） */
  models: Array<{ id: string; name?: string }>;
  /** 失败原因（ok=true 时 undefined） */
  error?: string;
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
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
