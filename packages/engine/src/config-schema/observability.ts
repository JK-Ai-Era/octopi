/**
 * observability / observer — 可观测性段（Telemetry + Run Observatory）
 *
 * @module
 */
import { z } from 'zod';

export const ObservabilityConfigSchema = z.object({
  level: z.number().int().min(0).max(5).optional(),
  consoleLevel: z.number().int().min(0).max(5).nullable().optional(),
  traceDir: z.string().nullable().optional(),
  captureStreamDeltas: z.boolean().optional(),
  captureModelRequest: z.boolean().optional(),
});

/**
 * 产品 Observer 通道（Run 观测 / Run Observatory）
 *
 * `level`：off（缺省）=关闭；summary/full=开启。webPanel 跟 level（off 强制关）。
 * 调试 REST：`/debug/run/:sessionId/scope|messages`（非 /api/v1）。
 * 显式 payload/channels/retention 覆盖预设；全文只认 payload+retention。
 * 与 Core Observer（observability / metrics/trace）为不同子域。
 */
export const ObserverConfigSchema = z
  .object({
    level: z.enum(['off', 'summary', 'full']).optional(),
    channels: z
      .object({
        'run.scope': z.boolean().optional(),
        'run.messages': z.boolean().optional(),
        'run.timeline': z.boolean().optional(),
        'run.guard': z.boolean().optional(),
        'context.layers': z.boolean().optional(),
        'context.compact': z.boolean().optional(),
        'context.llm': z.boolean().optional(),
        'tool.effect': z.boolean().optional(),
        security: z.boolean().optional(),
        memory: z.boolean().optional(),
      })
      .partial()
      .optional(),
    payload: z
      .object({
        layerContent: z.boolean().optional(),
        layerPreview: z.boolean().optional(),
        messageFullText: z.boolean().optional(),
        streamDelta: z.boolean().optional(),
        modelRequest: z.boolean().optional(),
      })
      .optional(),
    retention: z
      .object({
        runsPerSession: z.number().int().positive().max(64).optional(),
        timelineEvents: z.number().int().positive().max(2000).optional(),
        messagesPerRun: z.enum(['full', 'summary-only']).optional(),
      })
      .optional(),
    webPanel: z.boolean().optional(),
    failOpen: z.boolean().optional(),
  })
  .optional();
