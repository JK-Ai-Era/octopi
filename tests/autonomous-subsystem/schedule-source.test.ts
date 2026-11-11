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

  it('does not self-arm; pulseSchedule drives one tick', async () => {
    const onTrigger = vi.fn();
    engine.register(
      makeSpec({ sense: { source: 'schedule', interval: 30, isolation: 'structured' } }),
      onTrigger,
    );

    // P0c A′：register 不再自跳（run 实例零 self-arm 定时器，结构性断言面）
    await sleep(80);
    expect(onTrigger).not.toHaveBeenCalled();

    await engine.pulseSchedule('sched-sub');
    expect(onTrigger.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('respects cooldown between ticks', async () => {
    const onTrigger = vi.fn();
    const local = new SenseEngine({ events, defaultCooldownMs: 200 });
    local.register(
      makeSpec({ sense: { source: 'schedule', interval: 20, isolation: 'structured' } }),
      onTrigger,
    );

    // 6 次脉搏在 120ms 内打点，cooldown 200ms → 只放行 1 次
    for (let i = 0; i < 6; i++) {
      await local.pulseSchedule('sched-sub');
      await sleep(20);
    }
    local.dispose();
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

    await engine.pulseSchedule('sched-sub');
    expect(onTrigger).not.toHaveBeenCalled();

    engine.metricsStore.update('tick.allow', 1);
    await engine.pulseSchedule('sched-sub');
    expect(onTrigger.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('stops ticking after unregister', async () => {
    const onTrigger = vi.fn();
    engine.register(
      makeSpec({ sense: { source: 'schedule', interval: 20, isolation: 'structured' } }),
      onTrigger,
    );
    await engine.pulseSchedule('sched-sub');
    expect(onTrigger.mock.calls.length).toBeGreaterThanOrEqual(1);

    engine.unregister('sched-sub');
    // P0c A′：unregister 后脉搏 fail-loud（没有 timer 可停，驱动入口也没了）
    await expect(engine.pulseSchedule('sched-sub')).rejects.toThrow(/unknown pulse subsystem/);
    expect(onTrigger.mock.calls.length).toBe(1);
  });

  it('re-register replaces previous entry without double fire', async () => {
    const onTrigger = vi.fn();
    const spec = makeSpec({ sense: { source: 'schedule', interval: 30, isolation: 'structured' } });
    engine.register(spec, onTrigger);
    engine.register(spec, onTrigger);
    // P0c A′：无 timer 双份问题；一次脉搏恰好一次触发
    await engine.pulseSchedule('sched-sub');
    await engine.pulseSchedule('sched-sub');
    expect(onTrigger.mock.calls.length).toBe(2);
    expect(engine.pulseSpecs()).toHaveLength(1);
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

  it('runOnStart is declared to the scheduler; first pulse fires one tick', async () => {
    const onTrigger = vi.fn();
    engine.register(
      makeSpec({
        sense: { source: 'schedule', interval: 100_000, isolation: 'structured', runOnStart: true },
      }),
      onTrigger,
    );

    // P0c A′：register 不自跳；runOnStart 进脉搏声明（调度器首跳驱动）
    expect(engine.pulseSpecs()).toEqual([
      { key: 'subsystem.schedule:sched-sub', intervalMs: 100_000, runOnStart: true },
    ]);
    expect(onTrigger).not.toHaveBeenCalled();

    await engine.pulseSchedule('sched-sub');
    expect(onTrigger).toHaveBeenCalledTimes(1);
    // 首跳不带动后续（interval 100s 未到点，且无 self-arm）
    await sleep(30);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('without runOnStart no tick fires before pulse', async () => {
    const onTrigger = vi.fn();
    engine.register(
      makeSpec({ sense: { source: 'schedule', interval: 100_000, isolation: 'structured' } }),
      onTrigger,
    );

    await sleep(60);
    expect(onTrigger).not.toHaveBeenCalled();
    expect(engine.pulseSpecs()[0]?.runOnStart).toBeFalsy();
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
