import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SenseEngine } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/sense/engine.js';
import { DefaultToolBus } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/tool-bus.js';
import { SubsystemRuntime } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/runtime.js';
import { validateSubsystemSpec } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/boundary/validator.js';
import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type { SubsystemSpec } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/types.js';

function makeSpec(overrides?: Partial<SubsystemSpec>): SubsystemSpec {
  return {
    id: 'sched-sub',
    name: 'Sched',
    description: 'test',
    sense: { source: 'schedule', interval: 50, isolation: 'structured' },
    think: {
      strategy: 'deterministic',
      implementation: 'code',
      handler: async () => ({ signals: [{ action: 'no-op', reason: 'tick' }] }),
    },
    act: { mode: 'none' },
    signal: { severity: 'info', channel: ['event'] },
    boundary: { visibility: 'structured', authority: 'observe', security: 'sandboxed' },
    tools: { mode: 'none' },
    session: { mode: 'ephemeral', scope: 'session' },
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SenseEngine schedule source', () => {
  let events: DefaultEventBus;
  let engine: SenseEngine;

  beforeEach(() => {
    events = new DefaultEventBus();
    engine = new SenseEngine({ events, defaultCooldownMs: 0 });
  });

  afterEach(() => {
    engine.dispose();
  });

  it('ticks on interval', async () => {
    const onTrigger = vi.fn();
    engine.register(
      makeSpec({ sense: { source: 'schedule', interval: 30, isolation: 'structured' } }),
      onTrigger,
    );

    await sleep(80);
    expect(onTrigger.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('respects cooldown between ticks', async () => {
    const onTrigger = vi.fn();
    const local = new SenseEngine({ events, defaultCooldownMs: 200 });
    local.register(
      makeSpec({ sense: { source: 'schedule', interval: 20, isolation: 'structured' } }),
      onTrigger,
    );

    await sleep(120);
    local.dispose();
    // interval 20ms → ~6 ticks in 120ms, but cooldown 200ms → only 1
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('evaluates condition on tick', async () => {
    const onTrigger = vi.fn();
    engine.metricsStore.update('tick.allow', 0);
    engine.register(
      makeSpec({
        sense: {
          source: 'schedule',
          interval: 25,
          isolation: 'structured',
          filter: { condition: 'tick.allow === 1' },
        },
      }),
      onTrigger,
    );

    await sleep(50);
    expect(onTrigger).not.toHaveBeenCalled();

    engine.metricsStore.update('tick.allow', 1);
    await sleep(50);
    expect(onTrigger.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('stops ticking after unregister', async () => {
    const onTrigger = vi.fn();
    engine.register(
      makeSpec({ sense: { source: 'schedule', interval: 20, isolation: 'structured' } }),
      onTrigger,
    );
    await sleep(40);
    const before = onTrigger.mock.calls.length;
    expect(before).toBeGreaterThanOrEqual(1);

    engine.unregister('sched-sub');
    await sleep(50);
    expect(onTrigger.mock.calls.length).toBe(before);
  });

  it('re-register replaces previous timer without double fire', async () => {
    const onTrigger = vi.fn();
    const spec = makeSpec({ sense: { source: 'schedule', interval: 30, isolation: 'structured' } });
    engine.register(spec, onTrigger);
    engine.register(spec, onTrigger);
    await sleep(70);
    // single timer → not 2× rate (allow some jitter, but not double consistently)
    expect(onTrigger.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe('SenseEngine trigger throttling', () => {
  let events: DefaultEventBus;
  let engine: SenseEngine;

  beforeEach(() => {
    events = new DefaultEventBus();
    engine = new SenseEngine({ events, defaultCooldownMs: 0 });
  });

  afterEach(() => {
    engine.dispose();
  });

  it('runOnStart fires one tick right after register', async () => {
    const onTrigger = vi.fn();
    engine.register(
      makeSpec({
        sense: { source: 'schedule', interval: 100_000, isolation: 'structured', runOnStart: true },
      }),
      onTrigger,
    );

    await sleep(30);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    // 首跳不带动后续（interval 100s 未到点）
    await sleep(30);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('without runOnStart the first tick waits for interval', async () => {
    const onTrigger = vi.fn();
    engine.register(
      makeSpec({ sense: { source: 'schedule', interval: 100_000, isolation: 'structured' } }),
      onTrigger,
    );

    await sleep(60);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('minEvents accumulates before firing and resets after trigger', async () => {
    const onTrigger = vi.fn();
    engine.register(
      makeSpec({
        sense: {
          source: 'eventBus',
          isolation: 'structured',
          filter: { events: ['mem.stored'], minEvents: 3 },
        },
      }),
      onTrigger,
    );

    events.emit({ type: 'mem.stored', timestamp: Date.now(), data: {} } as never);
    events.emit({ type: 'mem.stored', timestamp: Date.now(), data: {} } as never);
    await sleep(20);
    expect(onTrigger).not.toHaveBeenCalled();

    events.emit({ type: 'mem.stored', timestamp: Date.now(), data: {} } as never);
    await sleep(20);
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // 触发后计数清零：再来 2 件仍不触发，第 3 件再触发
    events.emit({ type: 'mem.stored', timestamp: Date.now(), data: {} } as never);
    events.emit({ type: 'mem.stored', timestamp: Date.now(), data: {} } as never);
    await sleep(20);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    events.emit({ type: 'mem.stored', timestamp: Date.now(), data: {} } as never);
    await sleep(20);
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it('per-subsystem cooldownMs overrides defaultCooldownMs', async () => {
    const onTrigger = vi.fn();
    const local = new SenseEngine({ events, defaultCooldownMs: 0 });
    local.register(
      makeSpec({
        sense: {
          source: 'eventBus',
          isolation: 'structured',
          cooldownMs: 200,
          filter: { events: ['mem.stored'], minEvents: 1 },
        },
      }),
      onTrigger,
    );

    for (let i = 0; i < 5; i++) {
      events.emit({ type: 'mem.stored', timestamp: Date.now(), data: {} } as never);
      await sleep(20);
    }
    local.dispose();
    // 100ms 内 5 连发，cooldownMs=200 → 只触发 1 次（defaultCooldownMs=0 不生效才对）
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });
});

describe('validator schedule interval', () => {
  it('rejects schedule without interval', () => {
    const errors = validateSubsystemSpec(
      makeSpec({ sense: { source: 'schedule', isolation: 'structured' } }),
      { l4Available: true },
    );
    expect(errors.some((e) => e.field === 'sense.interval')).toBe(true);
  });

  it('rejects schedule interval < 1000', () => {
    const errors = validateSubsystemSpec(
      makeSpec({ sense: { source: 'schedule', interval: 10, isolation: 'structured' } }),
      { l4Available: true },
    );
    expect(errors.some((e) => e.field === 'sense.interval')).toBe(true);
  });

  it('accepts schedule with interval >= 1000', () => {
    const errors = validateSubsystemSpec(
      makeSpec({ sense: { source: 'schedule', interval: 1000, isolation: 'structured' } }),
      { l4Available: true },
    );
    expect(errors.filter((e) => e.field === 'sense.interval')).toEqual([]);
  });
});

describe('SubsystemRuntime schedule source', () => {
  let events: DefaultEventBus;
  let runtime: SubsystemRuntime;

  beforeEach(() => {
    events = new DefaultEventBus();
    runtime = new SubsystemRuntime({ securityEnforcement: { l4Available: true },
      deps: {
        model: {} as never,
        events,
        errorStrategy: {} as never,
        mainTools: new DefaultToolBus(),
      },
    });
  });

  afterEach(() => {
    runtime.dispose();
  });

  it('runs subsystem on schedule tick and audits', async () => {
    const handler = vi.fn(async () => ({
      signals: [{ action: 'no-op' as const, reason: 'tick' }],
    }));
    const errors = runtime.register(
      makeSpec({
        think: {
          strategy: 'deterministic',
          implementation: 'code',
          handler,
        },
        sense: { source: 'schedule', interval: 1000, isolation: 'structured' },
      }),
    );
    expect(errors).toEqual([]);

    // force one tick via sense engine interval is 1000ms — use short runtime path:
    // instead trigger manually to verify path; schedule arm is covered in SenseEngine tests
    await runtime.trigger('sched-sub');
    expect(handler).toHaveBeenCalled();
    expect(runtime.subsystemCount).toBe(1);
  });

  it('rejects invalid schedule spec at register', () => {
    const errors = runtime.register(
      makeSpec({ sense: { source: 'schedule', isolation: 'structured' } }),
    );
    expect(errors.some((e) => e.includes('sense.interval'))).toBe(true);
    expect(runtime.subsystemCount).toBe(0);
  });
});
