/**
 * budgetPolicy / runGuard / agentRuntime / concurrency — Run 域段（→ engine）
 *
 * @module
 */
import { z } from 'zod';

// ── Budget Policy（arch/budget-redesign.md：无 maxTokens/soft；键名仅 budgetPolicy）──

export const BudgetPolicyJsonConfigSchema = z.object({
  maxWallClockMs: z.number().positive().optional(),
  maxIterations: z.number().positive().optional(),
  maxToolCalls: z.number().positive().optional(),
  onPolicyHit: z.enum(['stop', 'wrap_up_then_stop']).optional(),
  wrapUpTurns: z.number().positive().optional(),
  contextWrapUpRatio: z.number().min(0).max(1).optional(),
  units: z.object({
    maxCost: z.number().positive().optional(),
    maxUncachedInputTokens: z.number().positive().optional(),
    maxOutputTokens: z.number().positive().optional(),
    maxLlmCalls: z.number().positive().optional(),
  }).optional(),
  pricing: z.record(z.string(), z.object({
    inputPer1M: z.number().positive(),
    cachedInputPer1M: z.number().positive().optional(),
    outputPer1M: z.number().positive(),
  })).optional(),
  advisory: z.object({
    unit: z.enum(['wall_clock_ms', 'cost', 'uncached_input_tokens', 'output_tokens', 'llm_calls']),
    threshold: z.number().positive(),
  }).optional(),
});

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

// ── Model Call（引擎 watchdog 超时：流式 idle + 绝对上限）──

export const ModelCallConfigSchema = z.object({
  /** 流式 chunk 间最大静默（含首 token 等待），毫秒 */
  idleTimeoutMs: z.number().positive().optional(),
  /** 单次模型调用总时长上限，毫秒 */
  absoluteTimeoutMs: z.number().positive().optional(),
  /**
   * 回退链单节点等待首个内容 chunk 的上限（毫秒）。
   * 仅在存在下一个候选时生效：超时即切下一个模型，不再让慢节点独占整个 watchdog 窗口。
   */
  fallbackAttemptTtftMs: z.number().positive().optional(),
  /** 回退链失败节点的降级窗口（毫秒）；缺省等于 fallbackAttemptTtftMs */
  fallbackDegradeTtlMs: z.number().positive().optional(),
  /**
   * 回退链单节点非流式（chat）整响应上限（毫秒），缺省 240000。
   *
   * chat 没有「首块」概念，不能复用 fallbackAttemptTtftMs 的 90s：
   * 合法的长响应会被误判为节点故障。取 240s 使其早于 undici 的 300s bodyTimeout。
   */
  fallbackChatAttemptMs: z.number().positive().optional(),
});

// ── Agent Runtime（消息路径始终经 Runtime；Source 按配置块挂载）──

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
  /**
   * AgentSignalSource（agent_signal 通知）挂载三态：
   * true=显式挂载；false=显式关闭（委派 notify 推送随之关闭，退化为 poll + 状态提示）；
   * 缺省=委派接线时自动补挂（委派 notify 推送的接收端）。
   */
  agentSignal: z.boolean().optional(),
});

/** SessionSchedule 预算与兜底（arch/session-schedules.md P1） */
export const SchedulesJsonConfigSchema = z.object({
  maxOpenPerSession: z.number().min(0).optional(),
  maxWakesPerHour: z.number().min(0).optional(),
  tickIntervalMs: z.number().min(0).optional(),
});

// ── Concurrency ──

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

export const ConcurrencyConfigSchema = z.object({
  providerPool: ProviderPoolConfigSchema.optional(),
  sessionGate: SessionGateConfigSchema.optional(),
});
