/**
 * 配置 Schema 校验（Zod）
 *
 * 定义所有配置字段的 schema，提供结构化校验。
 * 替代 config.ts 中的手动 throw 校验。
 *
 * @module
 */

import { z } from 'zod';

// ── Agent 配置 Schema ──

const InlinePersonaSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  systemPrompt: z.string({ error: 'Inline persona must have a systemPrompt' }).min(1, 'systemPrompt cannot be empty'),
});

const ToolPolicySchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

const InlineModelConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  contextWindow: z.number().positive().optional(),
});

const ModelConfigSchema = z.object({
  provider: z.string({ error: 'Agent must specify a model provider' }).min(1),
  model: z.string({ error: 'Agent must specify a model' }).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  contextWindow: z.number().positive('contextWindow must be a positive number').optional(),
  fallbackModels: z.array(z.union([z.string().min(1), InlineModelConfigSchema])).optional(),
});

export const AgentConfigSchema = z.object({
  id: z.string({ error: 'Agent must have an id' }).min(1, 'Agent id cannot be empty'),
  home: z.string().optional(),
  workspace: z.string().optional(),
  persona: z.union([z.string(), InlinePersonaSchema]).optional(),
  model: z.union([z.string().min(1), ModelConfigSchema]),
  tools: ToolPolicySchema.optional(),
  skillDirectory: z.string().optional(),
  skills: z.array(z.string()).optional(),
  channelBindings: z.record(z.string(), z.string()).optional(),
});

// ── Plugin 配置 Schema ──

export const PluginConfigSchema = z.object({
  loadPaths: z.array(z.string()).optional(),
  configs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

// ── Channel 配置 Schema ──

export const ChannelConfigSchema = z.object({
  type: z.string({ error: 'Channel must have a type' }).min(1),
  port: z.number().positive().optional(),
  path: z.string().optional(),
  apiKey: z.string().optional(),
  corsOrigins: z.array(z.string()).optional(),
});

// ── Budget 配置 Schema ──

export const BudgetJsonConfigSchema = z.object({
  maxTokens: z.number().positive().optional(),
  maxWallClockMs: z.number().positive().optional(),
  softTokens: z.number().positive().optional(),
  softWallClockMs: z.number().positive().optional(),
  maxIterations: z.number().positive().optional(),
  maxToolCalls: z.number().positive().optional(),
  autoRenewOnProgress: z.boolean().optional(),
  maxRenews: z.number().int().positive().optional(),
  renewGrantTokens: z.number().positive().optional(),
  renewGrantMs: z.number().positive().optional(),
}).refine(
  (data) => {
    if (data.softTokens !== undefined && data.maxTokens !== undefined) {
      return data.softTokens <= data.maxTokens;
    }
    return true;
  },
  { message: 'softTokens must be <= maxTokens' },
).refine(
  (data) => {
    if (data.softWallClockMs !== undefined && data.maxWallClockMs !== undefined) {
      return data.softWallClockMs <= data.maxWallClockMs;
    }
    return true;
  },
  { message: 'softWallClockMs must be <= maxWallClockMs' },
);

// ── RunGuard 配置 Schema ──

export const RunGuardJsonConfigSchema = z.object({
  enabled: z.boolean().optional(),
  checkpointInterval: z.number().positive().optional(),
  minCheckpointInterval: z.number().positive().optional(),
  maxCheckpointInterval: z.number().positive().optional(),
  enableLLMReview: z.boolean().optional(),
  llmReviewInterval: z.number().positive().optional(),
  llmModel: z.string().optional(),
  hardLimit: z.number().positive().optional(),
  hardWallClockMs: z.number().positive().optional(),
}).refine(
  (data) => {
    if (data.minCheckpointInterval !== undefined && data.maxCheckpointInterval !== undefined) {
      return data.minCheckpointInterval <= data.maxCheckpointInterval;
    }
    return true;
  },
  { message: 'minCheckpointInterval must be <= maxCheckpointInterval' },
);

// ── Agent Runtime 配置 Schema ──
// 消息路径始终经 Runtime；Source 按配置块挂载（无 enabled 总开关）

export const AgentRuntimeJsonConfigSchema = z.object({
  coalesceWindowMs: z.number().min(0).optional(),
  expectedMaxConcurrentRuns: z.number().positive().optional(),
  coalesceBufferLimit: z.number().positive().optional(),
  schedule: z
    .array(
      z.object({
        agentId: z.string().min(1),
        sessionId: z.string().optional(),
        intervalMs: z.number().positive().optional(),
        cron: z.string().optional(),
        content: z.string().min(1),
        coalesceKey: z.string().optional(),
        runOnStart: z.boolean().optional(),
      }),
    )
    .optional(),
  escalate: z
    .object({
      defaultAgentId: z.string().optional(),
      eventType: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .optional(),
  agentSignal: z.boolean().optional(),
});

// ── 上下文引擎配置 Schema ──

export const ContextEngineConfigSchema = z.object({
  type: z.enum(['default', 'custom']).optional(),
  protectFirstN: z.number().min(0).optional(),
  protectLastN: z.number().min(0).optional(),
  compactThreshold: z.number().min(0).max(1).optional(),
  proactiveCompactRatio: z.number().min(0).max(1).optional(),
  proactiveCooldownMs: z.number().min(0).optional(),
  outputRatio: z.number().min(0).max(1).optional(),
  minOutputReserve: z.number().positive().optional(),
  maxOutputReserve: z.number().positive().optional(),
  enableLLMSummary: z.boolean().optional(),
  summaryModel: z.string().optional(),
}).refine(
  (data) => {
    if (data.minOutputReserve !== undefined && data.maxOutputReserve !== undefined) {
      return data.minOutputReserve <= data.maxOutputReserve;
    }
    return true;
  },
  { message: 'minOutputReserve must be <= maxOutputReserve' },
);

export const ContextAssemblerConfigSchema = z.object({
  systemBudgetRatio: z.number().min(0.05).max(0.5).optional(),
  layerShares: z
    .record(
      z.enum(['wisdom', 'persona', 'skill', 'knowledge', 'cognition', 'memory', 'runtime']),
      z.number().min(0).max(1),
    )
    .optional(),
  includeLayerPreview: z.boolean().optional(),
  layerPreviewChars: z.number().int().positive().max(4000).optional(),
  includeLayerContent: z.boolean().optional(),
});

/** 全局运行宪法（产品资产 / 集成商替换 / 关闭） */
export const ConstitutionConfigSchema = z
  .object({
    mode: z.enum(['product', 'custom', 'off']),
    path: z.string().nullable().optional(),
  })
  .refine((d) => d.mode !== 'custom' || Boolean(d.path && String(d.path).trim()), {
    message: 'constitution.mode=custom requires path',
  });

export const MemoryConfigSchema = z.object({
  profile: z.enum(['personal_assistant', 'embedded_interactive', 'embedded_headless']).optional(),
  confidence: z
    .object({
      injectMinScore: z.number().min(0).max(1).optional(),
      channelPriors: z
        .object({
          user_directive: z.number().min(0).max(1).optional(),
          decision: z.number().min(0).max(1).optional(),
          fail_fix: z.number().min(0).max(1).optional(),
          model_inference: z.number().min(0).max(1).optional(),
          admin: z.number().min(0).max(1).optional(),
        })
        .optional(),
    })
    .optional(),
  gates: z
    .object({
      maxLength: z
        .object({
          fact: z.number().int().positive().optional(),
          method: z.number().int().positive().optional(),
          norm: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .optional(),
});

// ── 安全配置 Schema ──

export const SecurityConfigSchema = z.object({
  preset: z.enum(['development', 'testing', 'production', 'maximum']).optional(),
  injectionSensitivity: z.enum(['low', 'medium', 'high']).optional(),
});

// ── 并发控制配置 Schema ──

const RateLimitSlotSchema = z.object({
  requestsPerMinute: z.number().positive(),
  burstCapacity: z.number().positive().optional(),
  maxWaitMs: z.number().positive().optional(),
});

const PoolSlotSchema = z.object({
  provider: z.string().min(1),
  weight: z.number().positive().optional(),
  rateLimit: RateLimitSlotSchema.optional(),
});

const RoutingSchema = z.object({
  strategy: z.enum(['sticky', 'round-robin', 'least-loaded']).optional(),
  stickyTtlMs: z.number().positive().optional(),
  failover: z.enum(['auto', 'manual']).optional(),
});

const ProviderPoolConfigSchema = z.object({
  slots: z.array(PoolSlotSchema).min(1, 'ProviderPool requires at least one slot'),
  routing: RoutingSchema.optional(),
  rateLimit: RateLimitSlotSchema.optional(),
});

const SessionGateConfigSchema = z.object({
  maxConcurrent: z.number().positive().optional(),
  waitTimeoutMs: z.number().positive().optional(),
});

const ConcurrencyConfigSchema = z.object({
  providerPool: ProviderPoolConfigSchema.optional(),
  sessionGate: SessionGateConfigSchema.optional(),
});

// ── 可观测性配置 Schema ──

export const ObservabilityConfigSchema = z.object({
  level: z.number().int().min(0).max(5).optional(),
  consoleLevel: z.number().int().min(0).max(5).nullable().optional(),
  traceDir: z.string().nullable().optional(),
  captureStreamDeltas: z.boolean().optional(),
  captureModelRequest: z.boolean().optional(),
});

// ── Web Search 配置 Schema ──

const WebSearchProviderSlotSchema = z.object({
  api: z.enum(['duckduckgo', 'tavily', 'brave', 'serper', 'mimo']),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
  model: z.string().min(1).optional(),
  maxKeyword: z.number().int().min(1).max(10).optional(),
  forceSearch: z.boolean().optional(),
  userLocation: z.object({
    country: z.string().optional(),
    region: z.string().optional(),
    city: z.string().optional(),
  }).optional(),
});

const WebSearchConfigSchema = z.object({
  provider: z.string().min(1).optional(),
  fallbacks: z.array(z.string().min(1)).optional(),
  defaultLimit: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().positive().optional(),
  providers: z.record(z.string().min(1), WebSearchProviderSlotSchema).optional(),
}).refine(
  (data) => {
    if (!data.provider || !data.providers) return true;
    if (!data.providers[data.provider]) {
      return false;
    }
    return true;
  },
  { message: 'webSearch.provider must reference a key in webSearch.providers' },
).refine(
  (data) => {
    if (!data.fallbacks || !data.providers) return true;
    return data.fallbacks.every((k) => data.providers![k] !== undefined);
  },
  { message: 'webSearch.fallbacks entries must reference keys in webSearch.providers' },
);

// ── Session 配置 Schema ──

export const SessionConfigSchema = z.object({
  dmScope: z.enum(['main', 'per-peer', 'per-channel-peer']).optional(),
}).passthrough();

// ── 完整配置 Schema ──

// ── 集中模型定义 Schema ──

// ── 模型能力 Schema ──

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
  timeoutMs: z.number().int().positive().optional(),
  dimensions: z.number().int().positive().optional(),
  /** 向量检索引擎：auto=优先 sqlite-vec，不可用时退回 JS 余弦 */
  vectorEngine: z.enum(['auto', 'js', 'sqlite-vec']).optional(),
  /** sqlite-vec 扩展路径（可选；默认用 npm 包内置二进制） */
  sqliteVecExtensionPath: z.string().min(1).optional(),
});

const ModelsConfigSchema = z.object({
  mode: z.enum(['merge', 'replace']).optional(),
  providers: z.record(z.string(), ModelProviderConfigSchema),
  level: z.record(z.string(), LevelConfigSchema).optional(),
  embedding: EmbeddingModelConfigSchema.optional(),
});

const ModelDefinitionSchema = z.object({
  id: z.string().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  contextWindow: z.number().positive().optional(),
  fallbackModels: z.array(z.union([z.string().min(1), InlineModelConfigSchema])).optional(),
});

const DefaultsSchema = z.object({
  contextWindow: z.number().positive().optional(),
});

const SubsystemsConfigSchema = z.object({
  auditDir: z.string().optional(),
  /** 允许注册：子系统 id / packageId / `memory.steward.*` 前缀 */
  allowlist: z.array(z.string().min(1)).optional(),
  /** 禁止注册（deny 优先） */
  denylist: z.array(z.string().min(1)).optional(),
});

const WebConfigSchema = z.object({
  /** Web UI 源码目录（含 package.json 的 Vite 项目） */
  dir: z.string().optional(),
});

export const HarnessConfigSchema = z.object({
  subsystems: SubsystemsConfigSchema.optional(),
  agents: z.array(AgentConfigSchema).min(1, 'Config must define at least one agent'),
  models: ModelsConfigSchema,
  defaults: z.object({
    contextWindow: z.number().positive().optional(),
  }).optional(),
  plugins: PluginConfigSchema.optional(),
  budget: BudgetJsonConfigSchema.optional(),
  runGuard: RunGuardJsonConfigSchema.optional(),
  agentRuntime: AgentRuntimeJsonConfigSchema.optional(),
  contextEngine: ContextEngineConfigSchema.optional(),
  contextAssembler: ContextAssemblerConfigSchema.optional(),
  context: z
    .object({
      constitution: ConstitutionConfigSchema.optional(),
      contextAssembler: ContextAssemblerConfigSchema.optional(),
    })
    .optional(),
  constitution: ConstitutionConfigSchema.optional(),
  memory: MemoryConfigSchema.optional(),
  security: SecurityConfigSchema.optional(),
  channels: z.array(ChannelConfigSchema).optional(),
  session: SessionConfigSchema.optional(),
  observability: ObservabilityConfigSchema.optional(),
  concurrency: ConcurrencyConfigSchema.optional(),
  webSearch: WebSearchConfigSchema.optional(),
  web: WebConfigSchema.optional(),
});

// ── 校验结果类型 ──

export interface ConfigValidationResult {
  success: boolean;
  data?: z.infer<typeof HarnessConfigSchema>;
  errors?: ConfigValidationError[];
}

export interface ConfigValidationError {
  path: string;
  message: string;
  code: string;
}

/**
 * 校验配置数据
 *
 * @param raw - 原始 JSON 对象
 * @returns 校验结果（包含结构化错误信息）
 */
export function validateConfig(raw: unknown): ConfigValidationResult {
  const result = HarnessConfigSchema.safeParse(raw);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors: ConfigValidationError[] = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: extractBestMessage(issue),
    code: issue.code,
  }));

  return { success: false, errors };
}

/**
 * 校验并抛出（用于 loadConfig 内部）
 *
 * @param raw - 原始 JSON 对象
 * @returns 校验后的配置
 * @throws 校验失败时抛出格式化错误
 */
export function validateConfigOrThrow(raw: unknown): z.infer<typeof HarnessConfigSchema> {
  const result = validateConfig(raw);
  if (result.success) {
    const config = result.data!;

    // ── 交叉校验：slot 引用的 provider 必须存在 ──
    if (config.concurrency?.providerPool && config.models?.providers) {
      const providerNames = new Set(Object.keys(config.models.providers));
      for (const slot of config.concurrency.providerPool.slots) {
        if (!providerNames.has(slot.provider)) {
          throw new Error(
            `Config validation failed:\n  concurrency.providerPool.slots: ` +
            `provider "${slot.provider}" not found in models.providers. ` +
            `Available: ${[...providerNames].join(', ')}`
          );
        }
      }
    }

    return config;
  }

  const lines = result.errors!.map((e) => `  ${e.path || '(root)'}: ${e.message}`);
  throw new Error(
    `Config validation failed:\n${lines.join('\n')}`
  );
}

/**
 * 从 Zod issue 中提取最具体的错误消息
 *
 * 对于 union 类型的错误，深入到子错误中找到最相关的消息。
 */
function extractBestMessage(issue: z.ZodIssue): string {
  if (issue.code === 'invalid_union' && 'errors' in issue && Array.isArray(issue.errors)) {
    // 找到包含最多上下文信息的子错误
    let best = 'Invalid input';
    for (const group of issue.errors) {
      if (Array.isArray(group)) {
        for (const sub of group) {
          if (sub.message && sub.message !== 'Invalid input' && !sub.message.startsWith('Invalid input:')) {
            return sub.message;
          }
          if (sub.message && sub.message.startsWith('Invalid input:')) {
            best = sub.message;
          }
        }
      }
    }
    return best;
  }
  return issue.message;
}
