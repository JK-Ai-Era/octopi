/**
 * LogObserver — 日志观测器
 *
 * 将指标和日志输出到控制台。
 * 适用于开发和调试。
 */

import type { Observer, Span, LogLevel, SpanStatus } from '../../core/interfaces/observer.js';

class LogSpan implements Span {
  readonly id: string;
  readonly name: string;
  readonly startTime: number;
  private status: SpanStatus = 'ok';
  private attributes: Record<string, unknown> = {};

  constructor(name: string) {
    this.id = `span_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.name = name;
    this.startTime = Date.now();
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
    const duration = Date.now() - this.startTime;
    console.log(`[Span] ${this.name} (${duration}ms) [${this.status}]`, this.attributes);
  }
}

export class LogObserver implements Observer {
  recordMetric(name: string, value: number, tags?: Record<string, string>): void {
    const tagStr = tags ? ` ${JSON.stringify(tags)}` : '';
    console.log(`[Metric] ${name} = ${value}${tagStr}`);
  }

  startSpan(name: string, attributes?: Record<string, unknown>): Span {
    const span = new LogSpan(name);
    if (attributes) span.setAttributes(attributes);
    return span;
  }

  log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const ctxStr = context ? ` ${JSON.stringify(context)}` : '';
    const prefix = `[${level.toUpperCase()}]`;
    switch (level) {
      case 'error': console.error(`${prefix} ${message}${ctxStr}`); break;
      case 'warn': console.warn(`${prefix} ${message}${ctxStr}`); break;
      case 'debug': console.debug(`${prefix} ${message}${ctxStr}`); break;
      default: console.log(`${prefix} ${message}${ctxStr}`);
    }
  }
}
