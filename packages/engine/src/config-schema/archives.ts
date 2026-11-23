/**
 * archives —— 会话封存/回收站保留策略段（arch/session-archive-recycle.md §6）
 *
 * @module
 */
import { z } from 'zod';

/** `archives` 配置段 */
export const ArchivesConfigSchema = z.object({
  /**
   * 回收站存期（天）：移入回收站的会话封存包在 purgeAt=删除+该天数后由每日任务销毁。
   * 缺省 30。
   */
  trashRetentionDays: z.number().int().positive().optional(),
  /**
   * LLM wire dump（observability.llmRequestDump 落盘）是否随包封存。
   * 缺省 false = 封存时直接清除（诊断衍生品，不入回收站）；true 时入包
   * `llm-dumps/`，随包全生命周期（purge 时随包销毁）。
   */
  includeLlmDumps: z.boolean().optional(),
  /** 自动冷归档（收编旧 runArchive；每日任务执行） */
  autoArchive: z
    .object({
      /** 缺省 true */
      enabled: z.boolean().optional(),
      /** recent 会话 ended 超过该天数后自动封存（缺省 30） */
      recentRetentionDays: z.number().int().positive().optional(),
      /** 活跃会话静默超过该天数强制封存（缺省 90） */
      forceDays: z.number().int().positive().optional(),
      /** 自动归档包存期（天，到期销毁；缺省 180。手动归档不适用） */
      retentionDays: z.number().int().positive().optional(),
    })
    .optional(),
});

/** {@link ArchivesConfigSchema} 推断类型 */
export type ArchivesConfig = z.infer<typeof ArchivesConfigSchema>;
