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
  /**
   * LLM wire dump（前缀缓存比对）
   *
   * 默认关闭；开启后每个 LLM 调用落盘完整请求体 + 索引，可用 `octopi llm-diff` 比对。
   */
  llmRequestDump: z
    .object({
      enabled: z.boolean().optional(),
      /** 落盘根目录（缺省 `<OCTOPI_HOME>/logs/llm-requests`） */
      dir: z.string().optional(),
      /** 每 session 保留调用数（环形，缺省 200） */
      maxCallsPerSession: z.number().int().positive().max(5000).optional(),
      /** 单次请求体落盘上限（字节，缺省 8_000_000） */
      maxBodyBytes: z.number().int().positive().optional(),
      /** 响应留痕（正文+finishReason）截断上限（字符，缺省 2_000） */
      maxResponseChars: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * 事件循环停滞看门狗（缺省开启）
   *
   * worker 心跳检测主循环冻结，报告落 `<OCTOPI_HOME>/logs/loop-watchdog.jsonl`；
   * macOS 缺省自动 `sample` 抓阻塞栈。存在合法长同步作业的部署应放宽
   * `stallThresholdMs`（缺省 30_000）。
   */
  loopWatchdog: z
    .object({
      enabled: z.boolean().optional(),
      /** 心跳间隔（毫秒，缺省 5_000） */
      intervalMs: z.number().int().positive().optional(),
      /** 主循环静默多久判停滞（毫秒，缺省 30_000） */
      stallThresholdMs: z.number().int().positive().optional(),
      /** 报告落盘路径（缺省 `<OCTOPI_HOME>/logs/loop-watchdog.jsonl`） */
      reportFile: z.string().optional(),
      /** 停滞时自动 `sample` 抓主线程栈（macOS 专属；缺省 true） */
      captureSample: z.boolean().optional(),
    })
    .optional(),
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
