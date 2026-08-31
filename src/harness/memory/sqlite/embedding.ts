/**
 * Embedding Provider — 向量嵌入接口
 *
 * 可选增强。配置了 embedding API 时启用，未配置时退化为关键词检索。
 * 支持远程 API（OpenAI、Cohere 等）和本地 Ollama。
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

export interface EmbeddingConfig {
  /** 提供者类型 */
  type: 'openai' | 'ollama' | 'custom';
  /** API endpoint */
  endpoint?: string;
  /** API key */
  apiKey?: string;
  /** 模型名 */
  model?: string;
  /** 向量维度 */
  dimensions?: number;
}

/**
 * 创建 embedding provider
 *
 * 返回 null 表示未配置 embedding，退化为关键词检索。
 */
export function createEmbeddingProvider(config?: EmbeddingConfig): EmbeddingProvider | null {
  if (!config) return null;

  switch (config.type) {
    case 'ollama':
      return new OllamaEmbeddingProvider(
        config.endpoint ?? 'http://localhost:11434',
        config.model ?? 'bge-m3',
        config.dimensions ?? 1024,
      );
    case 'openai':
      return new OpenAIEmbeddingProvider(
        config.endpoint ?? 'https://api.openai.com/v1',
        config.apiKey ?? '',
        config.model ?? 'text-embedding-3-small',
        config.dimensions ?? 1536,
      );
    default:
      return null;
  }
}

/**
 * Ollama Embedding Provider
 */
class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';

  constructor(
    private endpoint: string,
    private model: string,
    readonly dimensions: number,
  ) {}

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.endpoint}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embedding failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json() as { embedding: number[] };
    return data.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama 不支持批量，逐条调用
    return Promise.all(texts.map(t => this.embed(t)));
  }
}

/**
 * OpenAI Embedding Provider
 */
class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';

  constructor(
    private endpoint: string,
    private apiKey: string,
    private model: string,
    readonly dimensions: number,
  ) {}

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.endpoint}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embedding failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.endpoint}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embedding batch failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data.map(d => d.embedding);
  }
}
