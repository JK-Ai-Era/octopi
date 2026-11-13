/**
 * contextEngine / contextAssembler / constitution / summary / compact — Context 域段
 *
 * @module
 */
import { z } from 'zod';

/** 历史工具结果批量冻结老化（F1-B2）：视图级降级、批量冻结、write-once */
export const HistoryAgingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  /** 跨轮原文保留条数（默认 20） */
  rawWindow: z.number().int().nonnegative().optional(),
  /**
   * 批量冻结步长（默认 60；最小 1）。⚠️ 1 = 逐候选即降级（等同渐进老化、
   * 每轮烧前缀缓存，仅调试用）；生产取值应 ≥ 每轮工具结果数——老化定位为
   * 污染控制后，优化目标是减少冻结事件次数，而不是尽早缩小视图。
   */
  freezeBatch: z.number().int().min(1).optional(),
  /** 指针目标字符数（默认 400） */
  maxPointerChars: z.number().int().positive().optional(),
  /**
   * 是否随结果老化同步降级该次调用的参数（默认 true）
   *
   * 参数是上下文中唯一无界增长的成分；只作用于「结果已被老化」的调用。
   */
  ageToolArgs: z.boolean().optional(),
  /** 参数摘要目标字符数（默认 320；过小会退化为整体轮廓、丢掉键名） */
  maxAgedArgChars: z.number().int().positive().optional(),
});

export const ContextEngineConfigSchema = z.object({
  type: z.enum(['default', 'custom']).optional(),
  protectFirstN: z.number().min(0).optional(),
  protectLastN: z.number().min(0).optional(),
  /** 摘要软目标预算（P1c 缺省 clamp(2%, 2k, 8k)） */
  summaryBudget: z
    .object({
      ratioPct: z.number().positive().optional(),
      minTokens: z.number().positive().optional(),
      maxTokens: z.number().positive().optional(),
    })
    .optional(),
  /** 0 = 禁新的路径 A 压缩（不只禁 LLM；不丢粘滞视图）；见 ContextEngineConfig JSDoc */
  proactiveCompactRatio: z.number().min(0).max(1).optional(),
  proactiveCooldownMs: z.number().min(0).optional(),
  /** 单次摘要 LLM 调用预算（ms）；0 = 不设预算（只受 provider 超时约束），缺省 300000 */
  summarizeTimeoutMs: z.number().min(0).optional(),
  historyAging: HistoryAgingConfigSchema.optional(),
  /** 工作目标 token（与窗口解耦，F1-B3）；0 = 只挂窗口比例线（proactiveCompactRatio） */
  targetTokens: z.number().int().nonnegative().optional(),
  /** 目标线倍数（默认 3；目标线 = targetTokens × 倍数，须 > B2 老化稳态） */
  compactFallbackRatio: z.number().positive().optional(),
  /** turn 内主动压缩的保护尾条数（默认 50，最小 1；活跃窗口——进行中工作记录不进压缩选段。0 不是「关闭」语义） */
  midTurnProtectLastN: z.number().int().min(1).optional(),
  outputRatio: z.number().min(0).max(1).optional(),
  minOutputReserve: z.number().positive().optional(),
  maxOutputReserve: z.number().positive().optional(),
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
  snapshotBudgetTokens: z.number().positive().optional(),
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
      ttlMs: z.number().int().positive().optional(),
      maxEntries: z.number().int().positive().optional(),
    })
    .optional(),
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
