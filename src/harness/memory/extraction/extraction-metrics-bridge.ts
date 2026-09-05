/**
 * Memory Extraction — ExtractionMetricsBridge
 *
 * 监听 memory.extractor.* 观测事件并聚合到 MetricsStore，
 * 供 condition 表达式、告警规则、dashboard 使用。
 *
 * 指标命名：
 * - memory.extractor.trigger.success
 * - memory.extractor.trigger.error
 * - memory.extractor.trigger.skip
 * - memory.extractor.bundle.eventCount (last)
 * - memory.extractor.accepted.count
 * - memory.extractor.pending.count
 *
 * @module harness/memory/extraction/extraction-metrics-bridge
 */

import type { EventBus, Disposable, AgentEvent } from '../../../core/primitives/event-bus.js';
import type { MetricsStore } from '../../autonomous-subsystem/sense/metrics.js';

export interface ExtractionMetricsBridgeOptions {
  /** 是否自动 attach（默认 true） */
  autoAttach?: boolean;
}

export class ExtractionMetricsBridge {
  private events: EventBus;
  private metrics: MetricsStore;
  private disposables: Disposable[] = [];

  constructor(events: EventBus, metrics: MetricsStore, options?: ExtractionMetricsBridgeOptions) {
    this.events = events;
    this.metrics = metrics;

    if (options?.autoAttach ?? true) {
      this.attach();
    }
  }

  attach(): void {
    this.disposables.push(
      this.events.on('memory.extractor.bridge.trigger.complete', () => {
        this.metrics.increment('memory.extractor.trigger.success');
      }),
    );

    this.disposables.push(
      this.events.on('memory.extractor.bridge.trigger.error', () => {
        this.metrics.increment('memory.extractor.trigger.error');
      }),
    );

    this.disposables.push(
      this.events.on('memory.extractor.bridge.bundle.hit', (e) => {
        const eventCount = (e.data as Record<string, unknown> | undefined)?.eventCount as number | undefined;
        if (typeof eventCount === 'number') {
          this.metrics.update('memory.extractor.bundle.eventCount', eventCount);
        }
      }),
    );

    this.disposables.push(
      this.events.on('memory.extractor.pending.scan.session.triggered', () => {
        this.metrics.increment('memory.extractor.trigger.success');
      }),
    );

    this.disposables.push(
      this.events.on('memory.extractor.pending.scan.session.error', () => {
        this.metrics.increment('memory.extractor.trigger.error');
      }),
    );

    this.disposables.push(
      this.events.on('memory.extractor.pending.scan.start', (e) => {
        const pendingCount = (e.data as Record<string, unknown> | undefined)?.pendingCount as number | undefined;
        if (typeof pendingCount === 'number') {
          this.metrics.update('memory.extractor.pending.count', pendingCount);
        }
      }),
    );

    // accepted count emitted by subsystem signal data
    this.disposables.push(
      this.events.on('subsystem.signal.suggest', (e) => {
        const data = (e.data ?? {}) as Record<string, unknown>;
        if (data.subsystemId !== 'memory.extractor') return;
        const accepted = data.extractedCount as number | undefined;
        if (typeof accepted === 'number') {
          this.metrics.update('memory.extractor.accepted.count', accepted);
        }
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
