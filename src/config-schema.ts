/**
 * 配置 Schema 校验（Zod）
 *
 * 定义所有配置字段的 schema，提供结构化校验。
 * 替代 config.ts 中的手动 throw 校验。
 *
 * @module
 */

import { z } from 'zod';

// ── Provider 配置 Schema ──

const ModelInfoSchema = z.object({
  name: z.string({ error: 'model entry must have a name' }).min(1, 'model entry must have a name'),
  contextWindow: z.number().positive('contextWindow must be a positive number').optional(),
  maxOutputTokens: z.number().positive('maxOutputTokens must be a positive number').optional(),
}).superRefine((data, ctx) => {
  if (data.contextWindow !== undefined && data.maxOutputTokens !== undefined) {
    if (data.maxOutputTokens > data.contextWindow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `maxOutputTokens (${data.maxOutputTokens}) exceeds contextWindow (${data.contextWindow})`,
      });
    }
  }
});

export const ProviderConfigSchema = z.object({
  type: z.enum(['openai', 'anthropic'], { error: 'Provider type must be "openai" or "anthropic"' }),
  name: z.string({ error: 'Provider must have a name' }).min(1, 'Provider name cannot be empty'),
  apiKey: z.string().optional(),
  baseUrl: z.string().url('baseUrl must be a valid URL').optional(),
  models: z.array(z.union([z.string(), ModelInfoSchema])).optional(),
  defaultModel: z.string().optional(),
  timeoutMs: z.number().positive('timeoutMs must be a positive number').optional(),
});

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

const ModelConfigSchema = z.object({
  provider: z.string({ error: 'Agent must specify a model provider' }).min(1),
  model: z.string({ error: 'Agent must specify a model' }).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  fallbackModels: z.array(z.string()).optional(),
});

export const AgentConfigSchema = z.object({
  id: z.string({ error: 'Agent must have an id' }).min(1, 'Agent id cannot be empty'),
  workspace: z.string().optional(),
  persona: z.union([z.string(), InlinePersonaSchema]).optional(),
  model: ModelConfigSchema,
  tools: ToolPolicySchema.optional(),
  skillDirectory: z.string().optional(),
  skills: z.array(z.string()).optional(),
  channelBindings: z.record(z.string(), z.string()).optional(),
}).refine(
  (data) => {
    // 内联 persona 必须有 systemPrompt（由 InlinePersonaSchema 保证）
    return true;
  },
);

// ── Plugin 配置 Schema ──

export const PluginConfigSchema = z.object({
  loadPaths: z.array(z.string()).optional(),
  configs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

// ── Store 配置 Schema ──

export const StoreConfigSchema = z.object({
  type: z.enum(['memory', 'jsonl'], { error: 'Store type must be "memory" or "jsonl"' }),
  dataDir: z.string().optional(),
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
}).passthrough();

// ── 完整配置 Schema ──

export const HarnessConfigSchema = z.object({
  agents: z.array(AgentConfigSchema).min(1, 'Config must define at least one agent'),
  providers: z.array(ProviderConfigSchema).optional(),
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
  store: StoreConfigSchema.optional(),
  channels: z.array(ChannelConfigSchema).optional(),
  session: SessionConfigSchema.optional(),
  observability: ObservabilityConfigSchema.optional(),
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
    return result.data!;
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
