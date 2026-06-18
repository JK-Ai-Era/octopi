/**
 * ObserverBridge — 实现 Core 层 Observer 接口
 *
 * 将 Engine 的 push 式观测调用桥接到：
 * - TraceLogger：结构化日志输出（控制台 + 文件）
 * - MetricsAggregator：指标聚合
 *
 * 设计意图：
 * - Core 层 Engine 通过 Observer 接口推送 span/metric/log
 * - Integration 层 ObserverBridge 接收并转发到具体后端
 * - 与 TraceCollector（拉模型）互补，不冲突
 */

import type { Observer, Span, LogLevel, SpanStatus } from '../../core/interfaces/observer.js';
import { TraceLogger, type TraceLoggerConfig } from './trace-logger.js';
import { MetricsAggregator, type MetricsAggregatorConfig } from './metrics.js';
import { TraceLevel, TRACE_EVENTS } from './trace-events.js';
import type { TraceEvent } from './trace-events.js';

// ── Span 实现 ──

class BridgeSpan implements Span {
  readonly id: string;
  readonly name: string;
  readonly startTime: number;
  private status: SpanStatus = 'ok';
  private attributes: Record<string, unknown> = {};
  private ended = false;
  private logger: TraceLogger;
  private metrics?: MetricsAggregator;

  constructor(
    name: string,
    logger: TraceLogger,
    metrics?: MetricsAggregator,
    attributes?: Record<string, unknown>,
  ) {
    this.id = `span_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.name = name;
    this.startTime = Date.now();
    this.logger = logger;
    this.metrics = metrics;
    if (attributes) this.attributes = { ...attributes };
  }

  setStatus(status: SpanStatus): void {
    this.status = status;
  }

  setAttribute(key: string, value: unknown): void {
    this.attributes[key] = value;
  }

  setAttributes(attributes: Record<string, unknown>): void {
    Object.assign(this.attributes, attributes);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const durationMs = Date.now() - this.startTime;

    const event: TraceEvent = {
      ts: Date.now(),
      level: this.status === 'error' ? TraceLevel.ERROR : TraceLevel.DEBUG,
      type: `span.${this.name}`,
      data: {
        spanId: this.id,
        durationMs,
        status: this.status,
        ...this.attributes,
      },
    };

    this.logger.log(event);

    // 工具执行延迟指标
    if (this.name === 'agent.tool.exec' && this.metrics) {
      const toolName = (this.attributes.toolName as string) ?? 'unknown';
      this.metrics.processEvent({
        ts: Date.now(),
        level: TraceLevel.INFO,
        type: 'tool.exec.end',
        data: { toolName, durationMs, hasError: this.status === 'error' },
      });
    }
  }
}

// ── ObserverBridge 配置 ──

export interface ObserverBridgeConfig {
  /** TraceLogger 配置 */
  logger?: Partial<TraceLoggerConfig>;
  /** MetricsAggregator 配置 */
  metrics?: MetricsAggregatorConfig;
  /** 预创建的实例（优先于配置） */
  loggerInstance?: TraceLogger;
  metricsInstance?: MetricsAggregator;
}

// ── ObserverBridge ──

/**
 * ObserverBridge — Observer → TraceLogger + MetricsAggregator
 *
 * 使用方式：
 * ```ts
 * const bridge = new ObserverBridge({
 *   logger: { level: TraceLevel.DEBUG, outputDir: './traces' },
 * });
 * builder.observer(bridge);
 * ```
 *
 * 与 TraceCollector 配合使用时，MetricsAggregator 可通过
 * `getMetricsAggregator()` 获取，或传入 TraceCollector。
 */
export class ObserverBridge implements Observer {
  readonly name = 'observer-bridge';
  private logger: TraceLogger;
  private metrics: MetricsAggregator;

  constructor(config?: ObserverBridgeConfig) {
    this.logger = config?.loggerInstance ?? new TraceLogger(config?.logger);
    this.metrics = config?.metricsInstance ?? new MetricsAggregator(config?.metrics);
  }

  // ── Observer 接口实现 ──

  recordMetric(name: string, value: number, tags?: Record<string, string>): void {
    const event: TraceEvent = {
      ts: Date.now(),
      level: TraceLevel.DEBUG,
      type: name,
      data: { value, ...tags },
    };
    this.logger.log(event);

    // 映射到 MetricsAggregator 的已知事件类型
    this.metrics.processEvent(this.mapMetricToEvent(name, value, tags));
  }

  startSpan(name: string, attributes?: Record<string, unknown>): Span {
    const span = new BridgeSpan(name, this.logger, this.metrics, attributes);

    // 记录 span 开始
    this.logger.debug(`span.${name}.start`, {
      spanId: span.id,
      ...attributes,
    });

    // 映射到 MetricsAggregator
    const mappedEvent = this.mapSpanStartToEvent(name, attributes);
    if (mappedEvent) {
      this.metrics.processEvent(mappedEvent);
    }

    return span;
  }

  log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const traceLevel = this.mapLogLevel(level);
    this.logger.log({
      ts: Date.now(),
      level: traceLevel,
      type: 'observer.log',
      data: { message, ...context },
    });
  }

  // ── 公共方法 ──

  /** 获取底层 TraceLogger */
  getLogger(): TraceLogger {
    return this.logger;
  }

  /** 获取 MetricsAggregator 实例 */
  getMetricsAggregator(): MetricsAggregator {
    return this.metrics;
  }

  /** 结束观测，flush 所有缓冲 */
  async finalize(): Promise<void> {
    await this.logger.finalize();
    this.metrics.destroy();
  }

  // ── 内部映射 ──

  private mapMetricToEvent(name: string, value: number, tags?: Record<string, string>): TraceEvent {
    // 映射已知指标名到 MetricsAggregator 理解的事件类型
    switch (name) {
      case 'agent.model.tokens.input':
        return { ts: Date.now(), level: TraceLevel.INFO, type: 'model.call.end', data: { usage: { promptTokens: value } } };
      case 'agent.model.tokens.output':
        return { ts: Date.now(), level: TraceLevel.INFO, type: 'model.call.end', data: { usage: { completionTokens: value } } };
      case 'agent.context.tokens':
        // 上下文 token 估算，不映射到 LLM 调用
        return { ts: Date.now(), level: TraceLevel.DEBUG, type: 'context.tokens', data: { value } };
      default:
        return { ts: Date.now(), level: TraceLevel.DEBUG, type: name, data: { value, ...tags } };
    }
  }

  private mapSpanStartToEvent(name: string, attributes?: Record<string, unknown>): TraceEvent | null {
    switch (name) {
      case 'agent.engine.run':
        return { ts: Date.now(), level: TraceLevel.INFO, type: TRACE_EVENTS.ENGINE_START, data: attributes as Record<string, unknown> };
      case 'agent.model.call':
        return { ts: Date.now(), level: TraceLevel.INFO, type: TRACE_EVENTS.MODEL_CALL_START, data: attributes as Record<string, unknown> };
      case 'agent.tool.exec':
        return { ts: Date.now(), level: TraceLevel.INFO, type: TRACE_EVENTS.TOOL_EXEC_START, data: attributes as Record<string, unknown> };
      case 'agent.iteration':
        // 迭代开始，MetricsAggregator 不直接处理这个
        return null;
      default:
        return null;
    }
  }

  private mapLogLevel(level: LogLevel): TraceLevel {
    switch (level) {
      case 'error': return TraceLevel.ERROR;
      case 'warn': return TraceLevel.WARN;
      case 'info': return TraceLevel.INFO;
      case 'debug': return TraceLevel.DEBUG;
      default: return TraceLevel.INFO;
    }
  }
}
