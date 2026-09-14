import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SenseEngine } from '../../src/harness/autonomous-subsystem/sense/engine.js';
import { SubsystemRuntime } from '../../src/harness/autonomous-subsystem/runtime.js';
import { DefaultEventBus } from '../../src/core/primitives/event-bus.js';
import type { SubsystemSpec } from '../../src/harness/autonomous-subsystem/types.js';

function makeSpec(overrides?: Partial<SubsystemSpec>): SubsystemSpec {
  return {
    id: 'test-subsystem',
    name: 'Test',
    description: 'test',
    sense: { source: 'eventBus', filter: { events: ['test.event'] }, isolation: 'structured' },
    think: {
      strategy: 'deterministic',
      implementation: 'code',
      handler: async () => ({ signals: [{ action: 'no-op', reason: 'test' }] }),
    },
    act: { mode: 'none' },
    signal: { severity: 'info', channel: ['event'] },
    boundary: { visibility: 'structured', authority: 'observe', security: 'sandboxed' },
    tools: { mode: 'none' },
    session: { mode: 'ephemeral', scope: 'session' },
    ...overrides,
  };
}

describe('SenseEngine.detectCycles', () => {
  let events: DefaultEventBus;
  let engine: SenseEngine;

  beforeEach(() => {
    events = new DefaultEventBus();
    engine = new SenseEngine({ events });
  });

  afterEach(() => {
    engine.dispose();
  });

  it('returns empty for independent subsystems', () => {
    const specs = [
      makeSpec({
        id: 'a',
        sense: { source: 'eventBus', filter: { events: ['evt.x'], emits: ['evt.y'] }, isolation: 'structured' },
      }),
      makeSpec({
        id: 'b',
        sense: { source: 'eventBus', filter: { events: ['evt.z'], emits: ['evt.w'] }, isolation: 'structured' },
      }),
    ];
    expect(engine.detectCycles(specs)).toEqual([]);
  });

  it('detects two-node cycle A ↔ B', () => {
    const specs = [
      makeSpec({
        id: 'a',
        sense: { source: 'eventBus', filter: { events: ['from.b'], emits: ['to.b'] }, isolation: 'structured' },
      }),
      makeSpec({
        id: 'b',
        sense: { source: 'eventBus', filter: { events: ['to.b'], emits: ['from.b'] }, isolation: 'structured' },
      }),
    ];
    const cycles = engine.detectCycles(specs);
    expect(cycles.length).toBeGreaterThan(0);
    const flat = cycles.flat();
    expect(flat).toContain('a');
    expect(flat).toContain('b');
  });

  it('detects self-loop when subsystem listens and emits the same event', () => {
    const specs = [
      makeSpec({
        id: 'self',
        sense: { source: 'eventBus', filter: { events: ['loop.evt'], emits: ['loop.evt'] }, isolation: 'structured' },
      }),
    ];
    expect(engine.detectCycles(specs)).toEqual([['self', 'self']]);
  });

  it('does not treat wildcard-only emits as self-loop', () => {
    const specs = [
      makeSpec({
        id: 'wild-self',
        sense: { source: 'eventBus', filter: { events: ['anything'], emits: ['*'] }, isolation: 'structured' },
      }),
    ];
    expect(engine.detectCycles(specs)).toEqual([]);
  });

  it('treats wildcard emits as producing any listened event for multi-node cycles', () => {
    const specs = [
      makeSpec({
        id: 'wild',
        sense: { source: 'eventBus', filter: { events: ['from.b'], emits: ['*'] }, isolation: 'structured' },
      }),
      makeSpec({
        id: 'b',
        sense: { source: 'eventBus', filter: { events: ['from.wild'], emits: ['from.b'] }, isolation: 'structured' },
      }),
    ];
    // wild listens from.b (b emits) → wild→b
    // b listens from.wild (wild emits *) → b→wild
    const cycles = engine.detectCycles(specs);
    expect(cycles.length).toBeGreaterThan(0);
    const flat = cycles.flat();
    expect(flat).toContain('wild');
    expect(flat).toContain('b');
  });

  it('respects top-level emits over filter.emits', () => {
    const specs = [
      makeSpec({
        id: 'a',
        emits: ['evt.b'],
        sense: { source: 'eventBus', filter: { events: ['evt.a'], emits: ['should.not.use'] }, isolation: 'structured' },
      }),
      makeSpec({
        id: 'b',
        emits: ['evt.a'],
        sense: { source: 'eventBus', filter: { events: ['evt.b'] }, isolation: 'structured' },
      }),
    ];
    expect(engine.detectCycles(specs).length).toBeGreaterThan(0);
  });

  it('ignores non-eventBus sources for listen edges', () => {
    const specs = [
      makeSpec({
        id: 'sched',
        sense: { source: 'schedule', interval: 1000, isolation: 'structured' },
        emits: ['evt.x'],
      }),
      makeSpec({
        id: 'listen',
        sense: { source: 'eventBus', filter: { events: ['evt.x'] }, isolation: 'structured' },
        emits: ['evt.y'],
      }),
    ];
    // listen → sched edge exists; sched does not listen, so no cycle
    expect(engine.detectCycles(specs)).toEqual([]);
  });
});

describe('SubsystemRuntime.register cycle rejection', () => {
  let events: DefaultEventBus;
  let runtime: SubsystemRuntime;

  beforeEach(() => {
    events = new DefaultEventBus();
    runtime = new SubsystemRuntime({
      deps: {
        model: {} as never,
        events,
        errorStrategy: {} as never,
        mainTools: new Map(),
      },
    });
  });

  afterEach(() => {
    runtime.dispose();
  });

  it('rejects registration that closes a cycle with an existing subsystem', () => {
    const first = runtime.register(
      makeSpec({
        id: 'a',
        sense: { source: 'eventBus', filter: { events: ['from.b'], emits: ['to.b'] }, isolation: 'structured' },
      }),
    );
    expect(first).toEqual([]);

    const second = runtime.register(
      makeSpec({
        id: 'b',
        sense: { source: 'eventBus', filter: { events: ['to.b'], emits: ['from.b'] }, isolation: 'structured' },
      }),
    );
    expect(second.length).toBeGreaterThan(0);
    expect(second[0]).toContain('cycle detected');
    expect(second[0]).toContain('a');
    expect(second[0]).toContain('b');
    expect(runtime.subsystemCount).toBe(1);
  });

  it('rejects self-loop registration', () => {
    const errors = runtime.register(
      makeSpec({
        id: 'self',
        sense: { source: 'eventBus', filter: { events: ['loop.evt'], emits: ['loop.evt'] }, isolation: 'structured' },
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('cycle detected');
    expect(runtime.subsystemCount).toBe(0);
  });

  it('allows eventBus listener with wildcard emits (not a self-loop)', () => {
    const errors = runtime.register(
      makeSpec({
        id: 'wild-llm',
        sense: { source: 'eventBus', filter: { events: ['tool.call'], emits: ['*'] }, isolation: 'structured' },
      }),
    );
    expect(errors).toEqual([]);
    expect(runtime.subsystemCount).toBe(1);
  });

  it('allows independent subsystems after a would-be cycle member is absent', () => {
    runtime.register(
      makeSpec({
        id: 'a',
        sense: { source: 'eventBus', filter: { events: ['from.b'], emits: ['to.b'] }, isolation: 'structured' },
      }),
    );
    const errors = runtime.register(
      makeSpec({
        id: 'c',
        sense: { source: 'eventBus', filter: { events: ['other'], emits: ['other.out'] }, isolation: 'structured' },
      }),
    );
    expect(errors).toEqual([]);
    expect(runtime.subsystemCount).toBe(2);
  });

  it('does not reject an unrelated new subsystem when existing set has no cycle', () => {
    // memory-like: listen lifecycle, no emits
    runtime.register(
      makeSpec({
        id: 'extractor',
        sense: { source: 'eventBus', filter: { events: ['session.lifecycle.updated'] }, isolation: 'structured' },
      }),
    );
    const errors = runtime.register(
      makeSpec({
        id: 'guard',
        sense: { source: 'eventBus', filter: { events: ['tool_call.risk_unknown'] }, isolation: 'structured' },
      }),
    );
    expect(errors).toEqual([]);
    expect(runtime.subsystemCount).toBe(2);
  });
});
