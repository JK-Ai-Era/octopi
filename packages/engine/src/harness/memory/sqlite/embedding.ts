/**
 * Embedding Provider — 向量嵌入接口
 *
 * 可选增强。未配置时退化为关键词检索。
 *
 * 协议形态：
 * - `openai`：OpenAI 兼容 `/embeddings`（可无 apiKey；可自定义 path/headers）
 * - `ollama`：`/api/embeddings`
 * - `http`：通用 JSON 映射（path + 请求字段 + 响应 embeddingsPath）
 *
 * 不要求本机部署模型：远程 OpenAI 兼容网关 / 内网 TEI / 无鉴权代理均可。
 *
 * @module
 */

export interface EmbeddingProvider {
  /** 提供者名称 */
  readonly name: string;
  /** 向量维度 */
  readonly dimensions: number;
  /** 生成 embedding；输入超模型上下文时由实现做截断回退 */
  embed(text: string): Promise<number[]>;
  /**
   * 批量生成 embedding。
   * 与入参等长；失败条目为空数组，由调用方按条续试（禁止静默丢条）。
   */
  embedBatch(texts: string[]): Promise<number[][]>;
}

/** HTTP 请求/响应字段映射（type=http 或覆盖 openai/ollama 默认） */
export interface EmbeddingHttpMapping {
  /** 请求体中文本字段（单条/数组共用） */
  inputField?: string;
  /** 请求体中模型字段 */
  modelField?: string;
  /**
   * 响应中向量路径。
   * - 单条：`embedding` / `data.0.embedding`
   * - 批量：`data`（每项再取 itemEmbeddingPath）或 `embeddings`
   */
  embeddingsPath?: string;
  /** 批量时每一项的向量字段，默认 `embedding` */
  itemEmbeddingPath?: string;
  /** 附加到请求体的静态字段 */
  extraBody?: Record<string, unknown>;
}

export interface EmbeddingConfig {
  /**
   * 提供者类型
   * - openai：OpenAI 兼容（apiKey 可空）
   * - ollama：Ollama 本地/远程
   * - http：通用 JSON 协议
   */
  type: 'openai' | 'ollama' | 'http' | 'custom';
  /** API base（不含 path） */
  endpoint?: string;
  /** 兼容字段：等同 endpoint */
  baseUrl?: string;
  /** 请求 path；缺省 openai=/embeddings，ollama=/api/embeddings，http 必填或用 /embeddings */
  path?: string;
  /** API Key；空/缺省则不发送鉴权头（适合内网/无鉴权远程） */
  apiKey?: string;
  /** Key 所在 Header；默认 Authorization。设为空字符串表示不发送 */
  apiKeyHeader?: string;
  /** Key 前缀；Authorization 默认 "Bearer "，其它 header 默认空 */
  apiKeyPrefix?: string;
  /** 额外请求头 */
  headers?: Record<string, string>;
  /** 字段映射 */
  request?: EmbeddingHttpMapping;
  /** 模型名 */
  model?: string;
  /**
   * 用户显式指定的向量维度。
   * **仅当写出时**才会放入请求体 `dimensions`；未写出则由服务端决定
   * （百炼 qwen3.7-text-embedding 默认 1024，勿假定 1536）。
   */
  dimensions?: number;
  /**
   * 单次 embedBatch 上限（超出自动切片）。
   * 百炼 qwen3.7-text-embedding 批次为 20；OpenAI 官方可更大。省略 = 不切片（由服务端裁决，失败再串行）。
   */
  maxBatchSize?: number;
  /**
   * 是否支持批量接口。
   * http/openai 默认 true；ollama `/api/embeddings` 仅接受单条 prompt，默认 false。
   * false 时 embedBatch 串行调用 embed。
   */
  supportsBatch?: boolean;
  /** 请求超时 ms（默认 30000） */
  timeoutMs?: number;
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

/** 按点路径取值：`data.0.embedding` */
function getByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: any = obj;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function asEmbedding(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (typeof value[0] === 'number') return value as number[];
  // float32 buffer 等情况暂不支持
  return null;
}

/** 服务端提示输入超过模型上下文（Ollama/TEI/OpenAI 措辞不一） */
function isContextLengthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /context length|input length|prompt is too long|maximum context|too many tokens|exceeds the (max|context)|max_?tokens|token limit/i.test(
    msg,
  );
}

/**
 * 为 embedding 缩短输入：保头 72% + 尾 28%（表头/结论都在），中间用省略号衔接。
 * 全文仍留在检索侧；这里只影响向量语义覆盖面。
 */
function shrinkEmbedText(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  const marker = '\n…\n';
  const budget = Math.max(48, maxChars - marker.length);
  const head = Math.ceil(budget * 0.72);
  const tail = Math.floor(budget * 0.28);
  return `${t.slice(0, head)}${marker}${t.slice(t.length - tail)}`;
}

function defaultPath(type: EmbeddingConfig['type'], custom?: string): string {
  if (custom) return custom;
  if (type === 'ollama') return '/api/embeddings';
  return '/embeddings';
}

/**
 * 创建 embedding provider
 *
 * 返回 null 表示未配置，退化为关键词检索。
 */
export function createEmbeddingProvider(config?: EmbeddingConfig): EmbeddingProvider | null {
  if (!config) return null;

  const endpoint = (config.endpoint ?? config.baseUrl ?? '').replace(/\/+$/, '');
  if (!endpoint && config.type !== 'ollama' && config.type !== 'openai' && config.type !== 'custom') {
    // type=http 必须有 endpoint
    return null;
  }

  const type = config.type === 'custom' ? 'http' : config.type;
  const model = config.model ?? (type === 'ollama' ? 'bge-m3' : 'text-embedding-3-small');
  // 本地假定维度仅用于存储/接口契约；未显式配置时 **不** 写入请求体
  const dimensions =
    config.dimensions ?? (type === 'ollama' ? 1024 : 1536);
  const path = defaultPath(type, config.path);
  const base =
    endpoint ||
    (type === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1');

  return new HttpEmbeddingProvider({
    name: type === 'http' ? 'http' : type,
    url: joinUrl(base, path),
    model,
    dimensions,
    sendDimensions: config.dimensions != null,
    apiKey: config.apiKey ?? '',
    apiKeyHeader: config.apiKeyHeader,
    apiKeyPrefix: config.apiKeyPrefix,
    headers: config.headers,
    mapping: resolveDefaultMapping(type, config.request),
    // ollama `/api/embeddings` 的 prompt 是 string，批量数组会 400
    supportsBatch: config.supportsBatch ?? type !== 'ollama',
    maxBatchSize: config.maxBatchSize,
    timeoutMs: config.timeoutMs ?? 30_000,
  });
}

function resolveDefaultMapping(
  type: 'openai' | 'ollama' | 'http',
  custom?: EmbeddingHttpMapping,
): Required<Pick<EmbeddingHttpMapping, 'inputField' | 'modelField' | 'embeddingsPath' | 'itemEmbeddingPath'>> &
  EmbeddingHttpMapping {
  const base =
    type === 'ollama'
      ? {
          inputField: 'prompt',
          modelField: 'model',
          embeddingsPath: 'embedding',
          itemEmbeddingPath: 'embedding',
        }
      : {
          inputField: 'input',
          modelField: 'model',
          embeddingsPath: 'data',
          itemEmbeddingPath: 'embedding',
        };

  return {
    ...base,
    ...custom,
    inputField: custom?.inputField ?? base.inputField,
    modelField: custom?.modelField ?? base.modelField,
    embeddingsPath: custom?.embeddingsPath ?? base.embeddingsPath,
    itemEmbeddingPath: custom?.itemEmbeddingPath ?? base.itemEmbeddingPath,
  };
}

interface HttpEmbeddingOptions {
  name: string;
  url: string;
  model: string;
  dimensions: number;
  /** 仅用户显式配置时才把 dimensions 写入请求体 */
  sendDimensions: boolean;
  apiKey: string;
  apiKeyHeader?: string;
  apiKeyPrefix?: string;
  headers?: Record<string, string>;
  mapping: ReturnType<typeof resolveDefaultMapping>;
  supportsBatch: boolean;
  maxBatchSize?: number;
  timeoutMs: number;
}

/**
 * 通用 HTTP Embedding（OpenAI 兼容 / Ollama / 自定义 JSON 均走此实现）
 */
class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private readonly opts: HttpEmbeddingOptions;

  constructor(opts: HttpEmbeddingOptions) {
    this.opts = opts;
    this.name = opts.name;
    this.dimensions = opts.dimensions;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.opts.headers ?? {}),
    };
    const key = (this.opts.apiKey ?? '').trim();
    if (!key) return headers;

    const headerName = this.opts.apiKeyHeader ?? 'Authorization';
    if (!headerName) return headers;

    const prefix =
      this.opts.apiKeyPrefix ??
      (headerName.toLowerCase() === 'authorization' ? 'Bearer ' : '');
    headers[headerName] = `${prefix}${key}`;
    return headers;
  }

  private buildBody(input: string | string[]): Record<string, unknown> {
    const { mapping, model, dimensions, sendDimensions } = this.opts;
    const body: Record<string, unknown> = {
      ...(mapping.extraBody ?? {}),
      [mapping.modelField]: model,
      [mapping.inputField]: input,
    };
    // 仅用户显式配置 dimensions 时下发；否则由服务端决定（如百炼默认 1024）
    if (sendDimensions && dimensions > 0 && mapping.inputField !== 'prompt') {
      body.dimensions = dimensions;
    }
    return body;
  }

  private extractOne(payload: unknown): number[] {
    const { mapping } = this.opts;
    const batch = getByPath(payload, mapping.embeddingsPath);
    // 扁平数字数组 = 单条向量（ollama `{embedding:[...]}`）；须先于批量分支
    const direct = asEmbedding(batch);
    if (direct) return direct;
    // 批量路径下第一项（`data:[{embedding}]` / `embeddings:[[...]]`）
    if (Array.isArray(batch) && batch.length > 0) {
      const first = batch[0];
      if (Array.isArray(first) && typeof first[0] === 'number') return first as number[];
      const vec = getByPath(first, mapping.itemEmbeddingPath);
      return asEmbedding(vec) ?? [];
    }
    // 单条嵌套路径（如 data.0.embedding）
    const nested = getByPath(payload, mapping.itemEmbeddingPath);
    return asEmbedding(nested) ?? asEmbedding(getByPath(payload, 'embedding')) ?? [];
  }

  private extractMany(payload: unknown): number[][] {
    const { mapping } = this.opts;
    const batch = getByPath(payload, mapping.embeddingsPath);
    const out: number[][] = [];

    // 扁平数字数组 = 单条向量回包，不是批量
    const direct = asEmbedding(batch);
    if (direct) {
      out.push(direct);
      return out;
    }

    if (Array.isArray(batch)) {
      for (const item of batch) {
        if (Array.isArray(item) && typeof item[0] === 'number') {
          out.push(item as number[]);
          continue;
        }
        const vec = asEmbedding(getByPath(item, mapping.itemEmbeddingPath));
        // 保留空槽对齐下标；调用方按条重试，禁止静默丢条
        out.push(vec ?? []);
      }
    }

    if (out.length === 0) {
      const single = this.extractOne(payload);
      if (single.length > 0) out.push(single);
    }
    // 协议异常时以实际返回条数为准，由调用方决定是否串行重试
    return out;
  }

  /** 单次请求；不做截断回退 */
  private async embedRaw(text: string): Promise<number[]> {
    const res = await fetch(this.opts.url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(this.buildBody(text)),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    const rawText = await res.text().catch(() => '');
    let data: unknown = {};
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = {};
      }
    } else if (typeof (res as { json?: unknown }).json === 'function') {
      // 测试桩可能只实现 json()；真响应 body 空则维持 {}
      data = await res.json().catch(() => ({}));
    }
    if (!res.ok) {
      const errText =
        typeof (data as { error?: unknown })?.error === 'string'
          ? (data as { error: string }).error
          : rawText.slice(0, 200);
      throw new Error(
        `Embedding request failed: ${res.status} ${res.statusText} ${errText}`.slice(0, 400),
      );
    }
    const apiErr = (data as { error?: unknown })?.error;
    if (typeof apiErr === 'string' && apiErr) {
      throw new Error(`Embedding request failed: ${apiErr}`);
    }
    const vec = this.extractOne(data);
    if (!vec || vec.length === 0) {
      throw new Error(
        `Embedding response missing vector at path "${this.opts.mapping.embeddingsPath}"`,
      );
    }
    return vec;
  }

  async embed(text: string): Promise<number[]> {
    try {
      return await this.embedRaw(text);
    } catch (err) {
      // 模型上下文按 token 计：同字数中文密度不同，有的 2400 字能进有的不能
      if (!isContextLengthError(err)) throw err;
      let size = Math.min(text.trim().length, 1600);
      while (size >= 200) {
        try {
          return await this.embedRaw(shrinkEmbedText(text, size));
        } catch (e2) {
          if (!isContextLengthError(e2)) throw e2;
          size = Math.floor(size * 0.7);
        }
      }
      throw err;
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.opts.supportsBatch) {
      // 串行调用 embed（含截断回退）；单条失败不拖垮同批其它条
      const out: number[][] = [];
      let lastErr: unknown;
      let ok = 0;
      for (const t of texts) {
        try {
          const vec = await this.embed(t);
          out.push(vec);
          ok += 1;
        } catch (e) {
          lastErr = e;
          out.push([]);
        }
      }
      if (ok === 0 && lastErr) throw lastErr;
      return out;
    }

    // 服务端批次上限（如百炼 qwen3.7-text-embedding = 20）；超出切片
    const max = this.opts.maxBatchSize;
    if (max && max > 0 && texts.length > max) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += max) {
        const slice = texts.slice(i, i + max);
        out.push(...(await this.embedBatch(slice)));
      }
      return out;
    }

    const res = await fetch(this.opts.url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(this.buildBody(texts)),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) {
      // 批量失败时退回串行（部分网关只支持单条）；串行避免限流风暴
      if (texts.length > 1) {
        return this.embedSerial(texts);
      }
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Embedding batch failed: ${res.status} ${res.statusText} ${detail.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as unknown;
    const many = this.extractMany(data);
    if (many.length === texts.length) {
      // 对齐后仍有空槽：按条补齐（embed 内含上下文截断回退）；单条失败留空槽给上层续试
      for (let i = 0; i < many.length; i++) {
        if (many[i]?.length) continue;
        try {
          many[i] = await this.embed(texts[i]!);
        } catch {
          many[i] = [];
        }
      }
      return many;
    }
    if (texts.length > 1) return this.embedSerial(texts);
    return many.slice(0, 1);
  }

  /** 串行单条（批量失败回退；避免并发风暴触发限流） */
  private async embedSerial(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    let lastErr: unknown;
    let ok = 0;
    for (const t of texts) {
      try {
        out.push(await this.embed(t));
        ok += 1;
      } catch (e) {
        lastErr = e;
        out.push([]);
      }
    }
    if (ok === 0 && lastErr) throw lastErr;
    return out;
  }
}
