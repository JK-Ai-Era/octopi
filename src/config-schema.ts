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

// ── Store 配置 Schema ──

export const StoreConfigSchema = z.object({
  type: z.enum(['memory', 'jsonl', 'sqlite'], { error: 'Store type must be "memory", "jsonl", or "sqlite"' }),
  dataDir: z.string().optional(),
  dbPath: z.string().optional(),
}).refine(
  (data) => {
    if (data.type === 'jsonl' && !data.dataDir) {
      return false;
    }
    return true;
  },
  { message: 'Store type "jsonl" requires dataDir', path: ['dataDir'] },
);

// ── Channel 配置 Schema ──

export const ChannelConfigSchema = z.object({
  type: z.string({ error: 'Channel must have a type' }).min(1),
  port: z.number().positive().optional(),
  path: z.string().optional(),
  apiKey: z.string().optional(),
  corsOrigins: z.array(z.string()).optional(),
});

// ── Supervisor 配置 Schema ──

export const SupervisorConfigSchema = z.object({
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

// ── 上下文引擎配置 Schema ──

export const ContextEngineConfigSchema = z.object({
  type: z.enum(['default', 'custom']).optional(),
  protectFirstN: z.number().min(0).optional(),
  protectLastN: z.number().min(0).optional(),
  compactThreshold: z.number().min(0).max(1).optional(),
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

// ── 安全配置 Schema ──

export const SecurityConfigSchema = z.object({
  preset: z.enum(['development', 'testing', 'production', 'maximum']).optional(),
  injectionSensitivity: z.enum(['low', 'medium', 'high']).optional(),
});

export const DistributedIntelligenceConfigSchema = z.object({
  safetyGuard: z.object({
    enabled: z.boolean(),
    model: z.string().describe('provider/model 格式，如 xiaomi-coding/mimo-v2.5-pro').optional(),
    maxDurationMs: z.number().positive().optional(),
  }).optional(),
}).optional();

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

// ── Session 配置 Schema ──

export const SessionConfigSchema = z.object({
  dmScope: z.enum(['main', 'per-peer', 'per-channel-peer']).optional(),
  store: StoreConfigSchema.optional(),
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

const ModelsConfigSchema = z.object({
  mode: z.enum(['merge', 'replace']).optional(),
  providers: z.record(z.string(), ModelProviderConfigSchema),
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

export const HarnessConfigSchema = z.object({
  agents: z.array(AgentConfigSchema).min(1, 'Config must define at least one agent'),
  models: ModelsConfigSchema,
  defaults: z.object({
    contextWindow: z.number().positive().optional(),
  }).optional(),
  plugins: PluginConfigSchema.optional(),
  budget: z.object({
    maxIterations: z.number().positive().optional(),
    maxToolCalls: z.number().positive().optional(),
    maxTokens: z.number().positive().optional(),
    maxTimeMs: z.number().positive().optional(),
  }).partial().optional(),
  supervisor: SupervisorConfigSchema.optional(),
  contextEngine: ContextEngineConfigSchema.optional(),
  security: SecurityConfigSchema.optional(),
  distributedIntelligence: DistributedIntelligenceConfigSchema,
  channels: z.array(ChannelConfigSchema).optional(),
  session: SessionConfigSchema.optional(),
  observability: ObservabilityConfigSchema.optional(),
  concurrency: ConcurrencyConfigSchema.optional(),
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
