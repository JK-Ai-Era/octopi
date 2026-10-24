import { describe, it, expect, vi } from 'vitest';
import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import { MetricsStore } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/sense/metrics.js';
import { SessionLifecycleBridge } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/sense/session-lifecycle-bridge.js';

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

  it('metrics are latest-state (no latching) and agent-filtered', () => {
    const events = new DefaultEventBus({ debug: false });
    const metrics = new MetricsStore();
    const bridge = new SessionLifecycleBridge(events, metrics, {
      enableIdle: false,
      agentId: 'a1',
    });

    // 其他 agent 的事件不污染本 agent 指标
    events.emit({
      type: 'session.lifecycle.updated',
      timestamp: Date.now(),
      agentId: 'other-agent',
      sessionId: 's9',
      data: { lifecycle: 'recent' },
    });
    expect(metrics.get('session.lifecycle.recent')).toBeUndefined();

    events.emit({
      type: 'session.lifecycle.updated',
      timestamp: Date.now(),
      agentId: 'a1',
      sessionId: 's1',
      data: { lifecycle: 'recent' },
    });
    expect(metrics.get('session.lifecycle.recent')).toBe(1);

    // 换值清旧：读到的是「当前态」，不是 latching 假真值
    events.emit({
      type: 'session.lifecycle.updated',
      timestamp: Date.now(),
      agentId: 'a1',
      sessionId: 's1',
      data: { lifecycle: 'archived' },
    });
    expect(metrics.get('session.lifecycle.recent')).toBeUndefined();
    expect(metrics.get('session.lifecycle.archived')).toBe(1);

    bridge.dispose();
  });
});

// ── SubsystemRuntime 集成（回归：bridge 曾是死接线，metrics 永远为空） ──
// schedule 模式条件（ctx 只有 metrics）依赖 session.lifecycle.* / session.idle.ms；
// bridge 未接线时这些键在生产永不出现。

describe('SubsystemRuntime wires SessionLifecycleBridge', () => {
  it('session lifecycle events populate runtime metrics', async () => {
    const { SubsystemRuntime } = await import(
      '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/runtime.js'
    );
    const { DefaultToolBus } = await import(
      '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/tool-bus.js'
    );
    const events = new DefaultEventBus({ debug: false });
    const runtime = new SubsystemRuntime({ securityEnforcement: { l4Available: true },
      deps: {
        model: {} as never,
        events,
        errorStrategy: {} as never,
        mainTools: new DefaultToolBus(),
      },
    });

    events.emit({
      type: 'session.lifecycle.updated',
      timestamp: Date.now(),
      agentId: 'a1',
      sessionId: 's3',
      data: {
        lifecycle: 'recent',
        extractionStatus: 'pending',
        lastInteractionAt: Date.now() - 2000,
      },
    });

    expect(runtime.metrics.get('session.lifecycle.recent')).toBe(1);
    runtime.dispose();
  });
});
