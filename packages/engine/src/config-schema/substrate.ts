/**
 * memory / knowledge — Memory & Knowledge 域段（→ engine）
 *
 * @module
 */
import { z } from 'zod';

/** Knowledge 全局缺省（agents[].knowledge.recall 覆盖） */
export const KnowledgeConfigSchema = z.object({
  recall: z.enum(['off', 'hint', 'hybrid', 'inject']).optional(),
  autoInject: z
    .object({
      minScore: z.number().min(0).max(1).optional(),
      maxChunks: z.number().int().positive().max(20).optional(),
      budgetTokens: z.number().int().positive().optional(),
      budgetRatio: z.number().min(0).max(1).optional(),
      maxBudgetTokens: z.number().int().positive().optional(),
      minCoverage: z.number().min(0).max(1).optional(),
    })
    .optional(),
  hint: z
    .object({
      minScore: z.number().min(0).max(1).optional(),
    })
    .optional(),
  /** hybrid 融合 keyword 权重（0–1；默认 0.45） */
  keywordWeight: z.number().min(0).max(1).optional(),
  catalog: z
    .object({
      maxEntries: z.number().int().positive().max(100).optional(),
      showProgress: z.enum(['off', 'bucket', 'exact']).optional(),
      autoDescribe: z.boolean().optional(),
      groupByScope: z.boolean().optional(),
    })
    .optional(),
  query: z
    .object({
      includePriorUserTurns: z.number().int().min(0).max(5).optional(),
      skipIfUserTokensBelow: z.number().int().min(0).optional(),
    })
    .optional(),
  index: z
    .object({
      embedding: z.boolean().optional(),
      hybridKeyword: z.boolean().optional(),
      phaseA: z
        .object({
          concurrency: z.number().int().positive().optional(),
          debounceMs: z.number().int().nonnegative().optional(),
        })
        .optional(),
      phaseB: z
        .object({
          embedBatch: z.number().int().positive().optional(),
          concurrency: z.number().int().positive().optional(),
          ratePerMin: z.number().positive().optional(),
        })
        .optional(),
      queue: z.object({ maxDepth: z.number().int().positive().optional() }).optional(),
      /** 索引文件限额（按格式分级；缺省见 DEFAULT_KNOWLEDGE_FILE_LIMITS） */
      files: z
        .object({
          oversize: z.enum(['partial', 'skip']).optional(),
          maxFileBytes: z.number().int().positive().optional(),
          hardMaxFileBytes: z.number().int().positive().optional(),
          maxBytes: z
            .object({
              text: z.number().int().positive().optional(),
              pdf: z.number().int().positive().optional(),
              officeDoc: z.number().int().positive().optional(),
              sheet: z.number().int().positive().optional(),
            })
            .optional(),
          partial: z
            .object({
              maxSheets: z.number().int().positive().optional(),
              maxRowsPerSheet: z.number().int().positive().optional(),
              maxPdfPages: z.number().int().positive().optional(),
              maxTextChars: z.number().int().positive().optional(),
            })
            .optional(),
          parseTimeoutMs: z.number().int().positive().optional(),
          parseTimeoutPerMBMs: z.number().int().nonnegative().optional(),
          maxParseTimeoutMs: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .optional(),
  load: z
    .object({
      parseConcurrency: z.number().int().positive().optional(),
      diskWatermarkAlert: z.boolean().optional(),
    })
    .optional(),
  promotion: z
    .object({
      metrics: z
        .object({
          minSessions: z.number().int().positive().optional(),
          minHits: z.number().int().positive().optional(),
        })
        .optional(),
      stewardOnConverge: z.boolean().optional(),
    })
    .optional(),
  /** 会话附件（OP-15；arch/knowledge-session-attachments.md） */
  attachments: z
    .object({
      maxFiles: z.number().int().positive().max(64).optional(),
      maxFileBytes: z.number().int().positive().optional(),
      maxTotalBytes: z.number().int().positive().optional(),
      allowedExtensions: z.array(z.string()).optional(),
      parse: z
        .object({
          extract: z.boolean().optional(),
          keywordIndex: z.boolean().optional(),
          embedding: z.enum(['off', 'lazy', 'on-upload']).optional(),
        })
        .optional(),
      inject: z
        .object({
          fullTextMaxChars: z.number().int().positive().optional(),
          recallTopK: z.number().int().positive().max(50).optional(),
          inventory: z.boolean().optional(),
          intent: z.enum(['llm', 'off']).optional(),
          intentTimeoutMs: z.number().int().positive().optional(),
          emptyMessagePrompt: z.string().optional(),
        })
        .optional(),
      tools: z
        .object({
          attachmentsRootReadOnly: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});

export const MemoryConfigSchema = z.object({
  profile: z.enum(['personal_assistant', 'embedded_interactive', 'embedded_headless']).optional(),
  /** 自动补录脉搏（硬收敛 / idle / 覆盖差）；false 时省 LLM 成本，govern 仍可跑 */
  backfill: z
    .object({
      enabled: z.boolean().optional(),
      idleDelayMs: z.number().int().positive().optional(),
      gapScanMs: z.number().int().positive().optional(),
      minUserTurns: z.number().int().positive().optional(),
      minTotalChars: z.number().int().positive().optional(),
    })
    .optional(),
  /** 按类型衰减曲线（govern 每轮 decay()） */
  decay: z
    .object({
      typeParams: z
        .object({
          fact: z
            .object({
              idleDays: z.number().positive().optional(),
              factor: z.number().gt(0).lt(1).optional(),
              min: z.number().min(0).max(1).optional(),
            })
            .optional(),
          method: z
            .object({
              idleDays: z.number().positive().optional(),
              factor: z.number().gt(0).lt(1).optional(),
              min: z.number().min(0).max(1).optional(),
            })
            .optional(),
          norm: z
            .object({
              idleDays: z.number().positive().optional(),
              factor: z.number().gt(0).lt(1).optional(),
              min: z.number().min(0).max(1).optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
  /** health 双脉搏（MemoryHealthProbe 阈值；govern 仍可 1h schedule） */
  health: z
    .object({
      intervalMs: z.number().int().positive().optional(),
      shadowBacklogLimit: z.number().int().nonnegative().optional(),
      limits: z
        .object({
          fact: z.number().int().nonnegative().optional(),
          method: z.number().int().nonnegative().optional(),
          norm: z.number().int().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
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
  /** 检索相关性地板与混合排序（自动注入宁缺毋滥） */
  retrieval: z
    .object({
      /** 向量路径最低余弦相似度（默认 0.35）；低于则丢弃 */
      minSimilarity: z.number().min(0).max(1).optional(),
      /** 混合排序中相似度权重（默认 0.65），其余为 importance×confidence×decay */
      similarityWeight: z.number().min(0).max(1).optional(),
      /** 关键词路径最低命中分（默认 2） */
      minKeywordScore: z.number().min(0).optional(),
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
