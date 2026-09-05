/**
 * Memory Extraction — SLO Alert Evaluator（最小可用）
 *
 * 监听关键事件并基于 MetricsStore 值发射告警事件：
 * - memory.extractor.alert.high_error_rate
 * - memory.extractor.alert.high_pending
 *
 * 设计为轻量、可替换；后续可接入更完整告警系统。
 *
 * @module harness/memory/extraction/alert-evaluator
 */

import type { EventBus, Disposable, AgentEvent } from '../../../core/primitives/event-bus.js';
import type { MetricsStore } from '../../autonomous-subsystem/sense/metrics.js';

export interface AlertEvaluatorOptions {
  /** 错误率阈值（默认 0.2） */
  errorRateThreshold?: number;
  /** pending 阈值（默认 50） */
  pendingThreshold?: number;
}

export class AlertEvaluator {
  private events: EventBus;
  private metrics: MetricsStore;
  private options: AlertEvaluatorOptions;
  private disposables: Disposable[] = [];

  constructor(events: EventBus, metrics: MetricsStore, options?: AlertEvaluatorOptions) {
    this.events = events;
    this.metrics = metrics;
    this.options = options ?? {};

    this.attach();
  }

  attach(): void {
    // evaluate on trigger complete/error and pending scan complete
    this.disposables.push(
      this.events.on('memory.extractor.bridge.trigger.complete', () => this.evaluate('bridge')),
      this.events.on('memory.extractor.bridge.trigger.error', () => this.evaluate('bridge')),
      this.events.on('memory.extractor.pending.scan.complete', () => this.evaluate('pending')),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  private evaluate(source: string): void {
    const success = this.metrics.get('memory.extractor.trigger.success') ?? 0;
    const error = this.metrics.get('memory.extractor.trigger.error') ?? 0;
    const total = success + error;
    const errorRate = total > 0 ? error / total : 0;
    const pending = this.metrics.get('memory.extractor.pending.count') ?? 0;

    if (errorRate >= (this.options.errorRateThreshold ?? 0.2) && total >= 5) {
      this.events.emit({
        type: 'memory.extractor.alert.high_error_rate',
        timestamp: Date.now(),
        data: { source, errorRate, success, error, total },
      });
    }

    if (pending >= (this.options.pendingThreshold ?? 50)) {
      this.events.emit({
        type: 'memory.extractor.alert.high_pending',
        timestamp: Date.now(),
        data: { source, pending },
      });
    }
  }
}
