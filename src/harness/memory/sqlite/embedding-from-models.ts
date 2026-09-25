/**
 * 从 ModelsConfig.embedding 创建 EmbeddingProvider
 *
 * 配置放在 models 下：memory / knowledge / plugin 共用。
 * 未配置或 enabled=false 时返回 null，调用方走关键词检索。
 *
 * 鉴权语义：
 * - `embedding.apiKey` 为 `""`：强制无鉴权（即使 provider 有 key）
 * - `embedding.apiKey` 未写出且配置了 `provider`：继承该 provider 的 apiKey
 * - 两者都没有：无鉴权
 */

import type { EmbeddingModelConfig, ModelsConfig, ModelProviderConfig } from '../../../config.js';
import { createEmbeddingProvider, type EmbeddingConfig, type EmbeddingProvider } from './embedding.js';
import type { VectorEngineChoice } from '../../../config.js';

/** 解析后的 embedding 运行时选项（供 SqliteMemoryStore / AgentDatabase） */
export interface ResolvedEmbeddingRuntime {
  provider: EmbeddingProvider | null;
  vectorEngine: VectorEngineChoice;
  sqliteVecExtensionPath?: string;
  dimensions?: number;
  model: string;
  type: NonNullable<EmbeddingModelConfig['type']>;
}

function inferType(
  cfg: EmbeddingModelConfig,
  resolvedBaseUrl?: string,
): NonNullable<EmbeddingModelConfig['type']> {
  if (cfg.type && cfg.type !== 'custom') return cfg.type;
  if (cfg.path || cfg.request) return 'http';
  const base = (resolvedBaseUrl ?? cfg.baseUrl ?? '').toLowerCase();
  if (base.includes('11434') || base.includes('ollama')) return 'ollama';
  return 'openai';
}

/**
 * 从 models.embedding 解析 baseUrl / apiKey（可引用 models.providers）。
 *
 * apiKey：写出（含 ""）以 embedding 为准；未写出时才继承 provider。
 */
export function resolveEmbeddingEndpoint(
  embedding: EmbeddingModelConfig,
  providers?: Record<string, ModelProviderConfig>,
): { baseUrl?: string; apiKey?: string; type: NonNullable<EmbeddingModelConfig['type']> } {
  let baseUrl = embedding.baseUrl;
  let apiKey = embedding.apiKey;

  if (embedding.provider && providers?.[embedding.provider]) {
    const p = providers[embedding.provider];
    baseUrl = baseUrl ?? p.baseUrl;
    if (apiKey === undefined) apiKey = p.apiKey;
  }

  return { baseUrl, apiKey, type: inferType(embedding, baseUrl) };
}

/**
 * 判断 models.embedding 是否启用向量路径。
 */
export function isEmbeddingEnabled(models?: ModelsConfig | null): boolean {
  const emb = models?.embedding;
  if (!emb?.model) return false;
  return emb.enabled !== false;
}

/**
 * 解析完整 embedding 运行时配置。
 *
 * @returns 未启用时 provider 为 null
 */
export function resolveEmbeddingRuntime(models?: ModelsConfig | null): ResolvedEmbeddingRuntime | null {
  const emb = models?.embedding;
  if (!emb?.model || emb.enabled === false) return null;

  const { baseUrl, apiKey, type } = resolveEmbeddingEndpoint(emb, models?.providers);
  // 本地假定维度（存储/契约）；**仅 emb.dimensions 显式写出**才进请求体
  const localDimensions = emb.dimensions ?? (type === 'ollama' ? 1024 : 1536);

  const config: EmbeddingConfig = {
    type,
    model: emb.model,
    baseUrl,
    endpoint: baseUrl,
    path: emb.path,
    apiKey: apiKey ?? '',
    apiKeyHeader: emb.apiKeyHeader,
    apiKeyPrefix: emb.apiKeyPrefix,
    headers: emb.headers,
    request: emb.request,
    supportsBatch: emb.supportsBatch,
    maxBatchSize: emb.maxBatchSize,
    timeoutMs: emb.timeoutMs,
    dimensions: emb.dimensions,
  };

  return {
    provider: createEmbeddingProvider(config),
    vectorEngine: emb.vectorEngine ?? 'auto',
    sqliteVecExtensionPath: emb.sqliteVecExtensionPath,
    dimensions: localDimensions,
    model: emb.model,
    type,
  };
}

/**
 * 仅创建 EmbeddingProvider（便捷入口）。
 */
export function createEmbeddingProviderFromModels(models?: ModelsConfig | null): EmbeddingProvider | null {
  return resolveEmbeddingRuntime(models)?.provider ?? null;
}
