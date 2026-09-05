import { describe, it, expect } from 'vitest';
import { DefaultEventBus } from '../../../src/core/primitives/event-bus.js';
import { MetricsStore } from '../../../src/harness/autonomous-subsystem/sense/metrics.js';
import { ExtractionMetricsBridge } from '../../../src/harness/memory/extraction/extraction-metrics-bridge.js';
import { AlertEvaluator } from '../../../src/harness/memory/extraction/alert-evaluator.js';

describe('ExtractionMetricsBridge + AlertEvaluator', () => {
  it('should aggregate metrics and emit high_error_rate alert when threshold breached', async () => {
    const events = new DefaultEventBus({ debug: false });
    const metrics = new MetricsStore();

    const bridge = new ExtractionMetricsBridge(events, metrics);
    const alerts = new AlertEvaluator(events, metrics, { errorRateThreshold: 0.4, pendingThreshold: 100 });

    const alertTypes: string[] = [];
    const d = events.onAll((e) => {
      if (e.type.startsWith('memory.extractor.alert.')) alertTypes.push(e.type);
    });

    // simulate multiple successes then errors to breach rate
    for (let i = 0; i < 3; i++) events.emit({ type: 'memory.extractor.bridge.trigger.complete', timestamp: Date.now(), data: {} });
    for (let i = 0; i < 3; i++) events.emit({ type: 'memory.extractor.bridge.trigger.error', timestamp: Date.now(), data: {} });

    await new Promise((r) => setTimeout(r, 10));

    // rate=0.5 and total>=5 -> alert should fire
    expect(alertTypes).toContain('memory.extractor.alert.high_error_rate');

    d.dispose();
    bridge.dispose();
    alerts.dispose();
  });

  it('should emit high_pending alert when pending threshold breached', async () => {
    const events = new DefaultEventBus({ debug: false });
    const metrics = new MetricsStore();

    const bridge = new ExtractionMetricsBridge(events, metrics);
    const alerts = new AlertEvaluator(events, metrics, { errorRateThreshold: 0.9, pendingThreshold: 2 });

    const alertTypes: string[] = [];
    const d = events.onAll((e) => {
      if (e.type.startsWith('memory.extractor.alert.')) alertTypes.push(e.type);
    });

    // simulate pending scan start with high pending count
    events.emit({ type: 'memory.extractor.pending.scan.start', timestamp: Date.now(), data: { pendingCount: 10 } });
    // trigger complete to force evaluation
    events.emit({ type: 'memory.extractor.pending.scan.complete', timestamp: Date.now(), data: {} });

    await new Promise((r) => setTimeout(r, 10));

    expect(alertTypes).toContain('memory.extractor.alert.high_pending');

    d.dispose();
    bridge.dispose();
    alerts.dispose();
  });
});
