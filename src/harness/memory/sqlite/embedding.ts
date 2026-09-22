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
  /** 生成 embedding */
  embed(text: string): Promise<number[]>;
  /** 批量生成 embedding */
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
  /** 向量维度 */
  dimensions?: number;
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
    apiKey: config.apiKey ?? '',
    apiKeyHeader: config.apiKeyHeader,
    apiKeyPrefix: config.apiKeyPrefix,
    headers: config.headers,
    mapping: resolveDefaultMapping(type, config.request),
    // ollama `/api/embeddings` 的 prompt 是 string，批量数组会 400
    supportsBatch: config.supportsBatch ?? type !== 'ollama',
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
  apiKey: string;
  apiKeyHeader?: string;
  apiKeyPrefix?: string;
  headers?: Record<string, string>;
  mapping: ReturnType<typeof resolveDefaultMapping>;
  supportsBatch: boolean;
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
    const { mapping, model } = this.opts;
    const body: Record<string, unknown> = {
      ...(mapping.extraBody ?? {}),
      [mapping.modelField]: model,
      [mapping.inputField]: input,
    };
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
        if (vec) out.push(vec);
      }
    }

    if (out.length === 0) {
      const single = this.extractOne(payload);
      if (single.length > 0) out.push(single);
    }
    // 协议异常时以实际返回条数为准，由调用方决定是否串行重试
    return out;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(this.opts.url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(this.buildBody(text)),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Embedding request failed: ${res.status} ${res.statusText} ${detail.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as unknown;
    const vec = this.extractOne(data);
    if (!vec || vec.length === 0) {
      throw new Error(
        `Embedding response missing vector at path "${this.opts.mapping.embeddingsPath}"`,
      );
    }
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.opts.supportsBatch) {
      // 串行调用 embed，避免并发压垮单条接口
      const out: number[][] = [];
      for (const t of texts) {
        out.push(await this.embed(t));
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
      // 批量失败时退回串行（部分网关只支持单条）
      if (texts.length > 1) {
        return Promise.all(texts.map((t) => this.embed(t)));
      }
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Embedding batch failed: ${res.status} ${res.statusText} ${detail.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as unknown;
    const many = this.extractMany(data);
    if (many.length >= 1) {
      if (many.length === texts.length) return many;
      if (texts.length > 1) return Promise.all(texts.map((t) => this.embed(t)));
      return many.slice(0, 1);
    }
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
