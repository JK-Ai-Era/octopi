/**
 * contextEngine / contextAssembler / constitution / summary / compact — Context 域段
 *
 * @module
 */
import { z } from 'zod';

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
  systemBudgetTokens: z.number().positive().optional(),
  compactTargetTokens: z.number().positive().optional(),
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

/** 公用能力：summary（harness/context/capabilities） */
const ToolSummaryBindingConfigSchema = z.object({
  mode: z.enum(['auto', 'over_threshold', 'always', 'never', 'kind_sensitive']).optional(),
  maxReturnChars: z.number().int().positive().optional(),
  defaultPolicyId: z.string().optional(),
  kindFromSource: z.boolean().optional(),
  informationalKinds: z
    .array(
      z.enum(['web_page', 'file_text', 'document', 'code', 'api_json', 'log', 'conversation', 'opaque', 'auto']),
    )
    .optional(),
  onFail: z.enum(['truncate_l1', 'error']).optional(),
  gate: z
    .object({
      minTokens: z.number().int().nonnegative().optional(),
      minBytes: z.number().int().nonnegative().optional(),
      respectPolicyBudget: z.boolean().optional(),
    })
    .optional(),
});

export const SummaryConfigSchema = z.object({
  modelLevel: z.string().optional(),
  model: z.string().optional(),
  defaultInputBudgetTokens: z.number().int().positive().optional(),
  safetyMarginTokens: z.number().int().nonnegative().optional(),
  oversizedStrategy: z.enum(['map_reduce', 'window', 'truncate_fallback', 'fail']).optional(),
  gate: z
    .object({
      minTokens: z.number().int().nonnegative().optional(),
      minBytes: z.number().int().nonnegative().optional(),
      respectPolicyBudget: z.boolean().optional(),
    })
    .optional(),
  /** 按 policy id 整策略替换（不深合并） */
  policies: z.record(z.string(), z.any()).optional(),
  tools: z
    .object({
      maxReturnChars: z.number().int().positive().optional(),
    })
    .catchall(ToolSummaryBindingConfigSchema.optional())
    .optional(),
  cache: z
    .object({
      enabled: z.boolean().optional(),
      backend: z.enum(['memory', 'file']).optional(),
      ttlMs: z.number().int().positive().optional(),
      maxEntries: z.number().int().positive().optional(),
      dir: z.string().optional(),
    })
    .optional(),
});

/** 公用能力：compact 缺省（会话路径仍可用 contextEngine 键） */
export const CompactCapabilityConfigSchema = z.object({
  defaultProtectHead: z.number().int().nonnegative().optional(),
  defaultProtectTail: z.number().int().nonnegative().optional(),
  defaultTargetTokens: z.number().int().positive().optional(),
  defaultMode: z.enum(['structure_only', 'summary_only', 'head_tail_only', 'auto']).optional(),
});

/** 公用能力：documents（DocumentPort 读抽取） */
export const DocumentsConfigSchema = z.object({
  extract: z
    .object({
      enabled: z.boolean().optional(),
      backend: z.enum(['auto', 't0-only']).optional(),
      timeoutMs: z.number().int().positive().optional(),
      maxFileBytes: z.number().int().positive().optional(),
      allowedRoots: z.array(z.string()).optional(),
    })
    .optional(),
  legacy: z
    .object({
      converter: z.enum(['none', 'soffice', 'remote']).optional(),
      sofficePath: z.string().nullable().optional(),
      cacheDir: z.string().nullable().optional(),
      cacheMaxBytes: z.number().int().positive().optional(),
      timeoutMs: z.number().int().positive().optional(),
      maxInputBytes: z.number().int().positive().optional(),
    })
    .optional(),
  markitdown: z
    .object({
      enabled: z.boolean().optional(),
      command: z.string().optional(),
    })
    .optional(),
  enhanced: z
    .object({
      enabled: z.boolean().optional(),
      provider: z.string().optional(),
      endpoint: z.string().nullable().optional(),
      command: z.string().nullable().optional(),
      authRef: z.string().nullable().optional(),
      timeoutMs: z.number().int().positive().optional(),
      preferOn: z.array(z.string()).optional(),
    })
    .optional(),
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
