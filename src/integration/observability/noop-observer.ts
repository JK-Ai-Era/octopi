/**
 * NoopObserver — 空观测器
 *
 * 不记录任何数据。用于不需要可观测性的场景。
 * 零开销。
 */

import type { Observer, Span, LogLevel, SpanStatus } from '../../core/interfaces/observer.js';

class NoopSpan implements Span {
  readonly id = 'noop';
  readonly name = 'noop';
  readonly startTime = 0;
  setStatus(_status: SpanStatus): void {}
  setAttribute(_key: string, _value: unknown): void {}
  setAttributes(_attributes: Record<string, unknown>): void {}
  end(): void {}
}

export class NoopObserver implements Observer {
  recordMetric(_name: string, _value: number, _tags?: Record<string, string>): void {}
  startSpan(_name: string, _attributes?: Record<string, unknown>): Span {
    return new NoopSpan();
  }
  log(_level: LogLevel, _message: string, _context?: Record<string, unknown>): void {}
}
