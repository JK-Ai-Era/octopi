/**
 * Observability — 可观测性模块
 *
 * 分级结构化事件日志 + 指标收集 + Observer 实现
 */

// Observer 实现
export { NoopObserver } from './noop-observer.js';
export { LogObserver } from './log-observer.js';

// Trace 系统
export { TraceLevel, TRACE_LEVEL_NAMES, TRACE_EVENTS, getTraceLevelForEngineEvent } from './trace-events.js';
export type { TraceEvent } from './trace-events.js';
export { TraceLogger, getTraceLogger, resetTraceLogger } from './trace-logger.js';
export type { TraceLoggerConfig } from './trace-logger.js';
export { TraceCollector } from './trace-collector.js';
export type { TraceCollectorConfig } from './trace-collector.js';
export { ConsoleExporter, JsonlFileExporter, WebhookExporter, createExporter } from './exporters.js';
export type { TraceExporter, ExporterConfig, AnyExporterConfig, ConsoleExporterConfig, JsonlFileExporterConfig, WebhookExporterConfig } from './exporters.js';
export { MetricsAggregator, formatMetricsSnapshot } from './metrics.js';
export type { MetricsSnapshot, LatencyStats, MetricsAggregatorConfig } from './metrics.js';
