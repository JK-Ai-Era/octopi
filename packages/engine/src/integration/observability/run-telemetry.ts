/**
 * createRunTelemetry — Integration 观测装配实现
 *
 * 把 Harness 的 `AgentTraceOptions` 接到可观测后端。两路互补、不双计：
 *
 * - **push** LoopObserver：只补 Runner 事件流没有的 `model.call.start/end`（含 usage）
 * - **pull** RunTelemetry.onEvent：Runner 适配后事件（turn.end / tool.exec.* / engine.* / delta）
 *
 * 由 `octopi` 包入口 `setRunTelemetryFactory(createRunTelemetry)` 注册，
 * 使 `AgentBuilder.trace()` 一行启用完整观测链路（层约束：Harness 不 import Integration）。
 */

import type {
  AgentTraceOptions,
  RunTelemetry,
  RunTelemetryEventCtx,
} from '@octopi-agent/engine/harness/observability/run-telemetry.js';
import type { LoopObserver } from '@octopi-agent/core/loop/types.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import type { TokenUsage } from '@octopi-agent/core/types/turn.js';
import { TraceCollector } from './trace-collector.js';
import { MetricsAggregator, type MetricsAggregatorConfig } from './metrics.js';

export interface CreateRunTelemetryOptions {
  /** 传给 MetricsAggregator */
  metrics?: MetricsAggregatorConfig;
  /** 预创建实例（测试注入） */
  collector?: TraceCollector;
  metricsInstance?: MetricsAggregator;
  /**
   * 归因上下文解析（组合根注入，如 RunScope ALS）。
   * LoopObserver 路径的 model.call.* 行靠它带 sessionId/agentId。
   */
  resolveContext?: () => { sessionId?: string; agentId?: string };
}

/**
 * 创建一套 RunTelemetry
 *
 * @param options - 采集意图（AgentTraceOptions）+ 可选 Metrics/预创建实例
 * @returns RunTelemetry
 */
export function createRunTelemetry(
  options: AgentTraceOptions & CreateRunTelemetryOptions = {},
): RunTelemetry {
  const metrics =
    options.metricsInstance ??
    (options.metrics ? new MetricsAggregator(options.metrics) : undefined);

  let collector: TraceCollector | undefined = options.collector;
  let lastOptions: AgentTraceOptions = {
    captureStreamDeltas: false,
    captureToolArgs: true,
    enableMetrics: true,
    ...options,
  };

  function ensureCollector(traceOpts: AgentTraceOptions): TraceCollector {
    lastOptions = { ...lastOptions, ...traceOpts };
    if (!collector) {
      collector = new TraceCollector({
        captureStreamDeltas: lastOptions.captureStreamDeltas ?? false,
        captureModelRequest: lastOptions.captureModelRequest ?? false,
        captureToolArgs: lastOptions.captureToolArgs ?? true,
        captureToolResults: lastOptions.captureToolResults ?? false,
        enableMetrics: lastOptions.enableMetrics ?? true,
        metricsInstance: metrics,
      });
    }
    return collector;
  }

  return {
    /**
     * 只补 LLM 调用生命周期（Runner 事件流无 model.call.*）。
     * 工具事件由 onEvent 接收 Runner 的 tool.exec.*，避免双计。
     *
     * 计时按 callId 隔离（同 agent 并发 run 共用本 observer，单变量会互相覆盖）。
     */
    createLoopObserver(traceOpts: AgentTraceOptions): LoopObserver {
      const c = ensureCollector(traceOpts);
      /** callId → 计时状态（onLLMEnd 清理，无泄漏） */
      const calls = new Map<string, { startTs: number; ttftMs?: number }>();
      const ctx = () => options.resolveContext?.() ?? {};
      /** 无 callId 的旧调用方回退键（顺序调用沿用旧单变量语义；并发场景请传 callId） */
      const keyOf = (callId: string | undefined): string => callId ?? 'default';

      return {
        onLLMStart(params) {
          const startTs = Date.now();
          calls.set(keyOf(params.callId), { startTs });
          c.record(
            {
              type: 'model.call.start',
              timestamp: startTs,
              data: {
                model: params.model,
                callId: params.callId,
                reqChars: params.reqChars,
                toolChars: params.toolChars,
              },
            } as AgentEvent,
            ctx(),
          );
        },
        onLLMFirstToken(params) {
          const call = calls.get(keyOf(params.callId));
          if (call) call.ttftMs = params.ttftMs;
        },
        onLLMEnd(params) {
          const call = calls.get(keyOf(params.callId));
          calls.delete(keyOf(params.callId));
          // 无 start 记录（异常调用序）时 duration 缺省，不伪造 0
          const durationMs = call ? Date.now() - call.startTs : undefined;
          c.record(
            {
              type: 'model.call.end',
              timestamp: Date.now(),
              data: {
                model: params.model,
                callId: params.callId,
                usage: params.usage as TokenUsage | undefined,
                durationMs,
                ttftMs: params.ttftMs ?? call?.ttftMs,
                outChars: params.outChars,
                finishReason: params.finishReason,
              },
            } as AgentEvent,
            ctx(),
          );
        },
      };
    },

    onEvent(event: AgentEvent, ctx: RunTelemetryEventCtx) {
      ensureCollector(lastOptions).record(event, ctx);
    },

    finalize() {
      collector?.finalize();
    },
  };
}
