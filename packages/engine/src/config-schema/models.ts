/**
 * models / defaults — 模型目录段（→ @octopi-agent/engine）
 *
 * @module
 */
import { z } from 'zod';
import { InlineModelConfigSchema } from './shared.js';

const ModelInputTypeSchema = z.enum(['text', 'image', 'audio', 'video']);

const ModelCapabilitySchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  reasoning: z.boolean().optional(),
  input: z.array(ModelInputTypeSchema).optional(),
  contextWindow: z.number().positive().optional(),
  maxTokens: z.number().positive().optional(),
});

const ModelProviderConfigSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  api: z.enum(['openai-completions', 'anthropic-messages']),
  models: z.array(ModelCapabilitySchema).min(1),
  timeoutSeconds: z.number().positive().optional(),
});

const LevelConfigSchema = z.object({
  primary: z.string().min(1),
  fallback: z.array(z.string().min(1)).optional(),
});

/**
 * Embedding 模型配置（models.embedding）
 *
 * 放在 models 下：embedding 可能被 memory / knowledge / plugin 等多处复用。
 * 未配置（或 enabled=false）时各存储退化为关键词检索。
 *
 * 远程/无 Key：`apiKey` 可省略或为 ""（不发 Authorization）；亦可用 type=http
 * 自定义 path + 请求/响应字段，对接任意 JSON embedding 服务。
 */
const EmbeddingHttpMappingSchema = z.object({
  inputField: z.string().min(1).optional(),
  modelField: z.string().min(1).optional(),
  embeddingsPath: z.string().min(1).optional(),
  itemEmbeddingPath: z.string().min(1).optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
});

const EmbeddingModelConfigSchema = z.object({
  /** 显式关闭（缺省视为开启；仅当节点存在时才启用向量） */
  enabled: z.boolean().optional(),
  /** 嵌入 API 协议；缺省按 provider/baseUrl 推断（openai 兼容） */
  type: z.enum(['openai', 'ollama', 'http', 'custom']).optional(),
  /** 引用 models.providers 中的 key，继承 baseUrl；apiKey 仅在未写出时继承 */
  provider: z.string().min(1).optional(),
  /** 模型名（如 text-embedding-3-small / bge-m3） */
  model: z.string().min(1),
  baseUrl: z.string().min(1).optional(),
  /** API Key；"" 或省略 = 不发送鉴权（适合内网/无鉴权远程） */
  apiKey: z.string().optional(),
  apiKeyHeader: z.string().optional(),
  apiKeyPrefix: z.string().optional(),
  path: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  request: EmbeddingHttpMappingSchema.optional(),
  supportsBatch: z.boolean().optional(),
  /** 单次批量上限（百炼 qwen3.7-text-embedding=20；超出自动切片） */
  maxBatchSize: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** 显式配置时才写入请求体 dimensions；未配置由服务端决定（勿假定 1536） */
  dimensions: z.number().int().positive().optional(),
  /** 向量检索引擎：auto=优先 sqlite-vec，不可用时退回 JS 余弦 */
  vectorEngine: z.enum(['auto', 'js', 'sqlite-vec']).optional(),
  /** sqlite-vec 扩展路径（可选；默认用 npm 包内置二进制） */
  sqliteVecExtensionPath: z.string().min(1).optional(),
});

export const ModelsConfigSchema = z.object({
  mode: z.enum(['merge', 'replace']).optional(),
  providers: z.record(z.string(), ModelProviderConfigSchema),
  level: z.record(z.string(), LevelConfigSchema).optional(),
  embedding: EmbeddingModelConfigSchema.optional(),
});

export const ModelDefinitionSchema = z.object({
  id: z.string().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  contextWindow: z.number().positive().optional(),
  fallbackModels: z.array(z.union([z.string().min(1), InlineModelConfigSchema])).optional(),
});

export const DefaultsSchema = z.object({
  contextWindow: z.number().positive().optional(),
});

export const EmbeddingModelConfigSchemaExport = EmbeddingModelConfigSchema;
export const ModelProviderConfigSchemaExport = ModelProviderConfigSchema;
export const ModelCapabilitySchemaExport = ModelCapabilitySchema;
