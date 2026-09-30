/**
 * Observer — 可观测性接口
 *
 * 职责：记录指标、追踪、日志。
 * Integration 层实现具体后端（Prometheus、OpenTelemetry 等）。
 *
 * 设计要点：
 * - 所有方法都有默认 no-op 实现，不影响不需要观测的场景
 * - Span 支持父子关系（通过 attributes.parentId）
 * - 指标名称采用 snake_case，与 OpenTelemetry 约定一致
 */

// ── 类型定义 ──

/** 日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Span 状态 */
export type SpanStatus = 'ok' | 'error' | 'cancelled';

/** Span 接口 */
export interface Span {
  readonly id: string;
  readonly name: string;
  readonly startTime: number;
  setStatus(status: SpanStatus): void;
  setAttribute(key: string, value: unknown): void;
  setAttributes(attributes: Record<string, unknown>): void;
  end(): void;
}

// ── 接口定义 ──

/**
 * Observer 接口
 *
 * Integration 层实现具体后端。
 * Core 层在关键节点调用 observer 方法。
 */
export interface Observer {
  /** 记录数值指标 */
  recordMetric(name: string, value: number, tags?: Record<string, string>): void;

  /** 开始追踪 span */
  startSpan(name: string, attributes?: Record<string, unknown>): Span;

  /** 记录日志 */
  log(level: LogLevel, message: string, context?: Record<string, unknown>): void;
}

// ── 内置指标名 ──

/** 标准指标名称 */
export const Metrics = {
  /** 迭代次数 */
  ITERATION_COUNT: 'agent.iteration.count',
  /** 工具调用耗时 */
  TOOL_CALL_DURATION: 'agent.tool.call.duration_ms',
  /** 模型调用耗时 */
  MODEL_CALL_DURATION: 'agent.model.call.duration_ms',
  /** 输入 token 数 */
  TOKENS_INPUT: 'agent.model.tokens.input',
  /** 输出 token 数 */
  TOKENS_OUTPUT: 'agent.model.tokens.output',
  /** 错误计数 */
  ERROR_COUNT: 'agent.error.count',
  /** 安全事件计数 */
  SECURITY_EVENT_COUNT: 'agent.security.event.count',
  /** 循环总耗时 */
  LOOP_DURATION: 'agent.loop.duration_ms',
} as const;
