import { describe, it, expect, vi } from 'vitest';
import { DefaultEventBus } from '../../src/core/primitives/event-bus.js';
import { MetricsStore } from '../../src/harness/autonomous-subsystem/sense/metrics.js';
import { SessionLifecycleBridge } from '../../src/harness/autonomous-subsystem/sense/session-lifecycle-bridge.js';

function createBridge() {
  const events = new DefaultEventBus({ debug: false });
  const metrics = new MetricsStore();
  const bridge = new SessionLifecycleBridge(events, metrics, { enableIdle: false });
  return { events, metrics, bridge };
}

describe('SessionLifecycleBridge', () => {
  it('updateState should expose lifecycle/idle/extraction in getSessionSenseContext', () => {
    const { bridge } = createBridge();

    const now = Date.now();
    bridge.updateState({
      sessionId: 's1',
      agentId: 'a1',
      lifecycle: 'recent',
      extractionStatus: 'pending',
      lastInteractionAt: now - 10_000,
    });

    const ctx = bridge.getSessionSenseContext('s1');
    expect(ctx.sessionLifecycle).toBe('recent');
    expect(ctx.extractionStatus).toBe('pending');
    expect(ctx.idleMs).toBeGreaterThanOrEqual(10_000);
    expect(ctx.lastInteractionAt).toBeLessThanOrEqual(now);
  });

  it('should react to session.lifecycle.updated event', () => {
    const { events, bridge } = createBridge();

    events.emit({
      type: 'session.lifecycle.updated',
      timestamp: Date.now(),
      agentId: 'a1',
      sessionId: 's2',
      data: {
        lifecycle: 'recent',
        extractionStatus: 'pending',
        lastInteractionAt: Date.now() - 1000,
      },
    });

    const ctx = bridge.getSessionSenseContext('s2');
    expect(ctx.sessionLifecycle).toBe('recent');
    expect(ctx.extractionStatus).toBe('pending');
    expect(ctx.idleMs).toBeGreaterThanOrEqual(1000);
  });
});
