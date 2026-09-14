import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SubsystemRuntime } from '../../src/harness/autonomous-subsystem/runtime.js';
import { DefaultEventBus } from '../../src/core/primitives/event-bus.js';
import type { SubsystemSpec } from '../../src/harness/autonomous-subsystem/types.js';

function makeSpec(overrides?: Partial<SubsystemSpec>): SubsystemSpec {
  return {
    id: 'guidance-sub',
    name: 'Guidance',
    description: 'test',
    sense: { source: 'eventBus', filter: { events: ['test.fire'] }, isolation: 'structured' },
    think: {
      strategy: 'deterministic',
      implementation: 'code',
      handler: async () => ({
        signals: [
          { action: 'suggest', reason: 'consider retry', confidence: 0.8 },
          { action: 'escalate', reason: 'need human check', confidence: 0.9 },
        ],
      }),
    },
    act: { mode: 'none' },
    signal: { severity: 'warning', channel: ['steering', 'escalate'] },
    boundary: { visibility: 'structured', authority: 'suggest', security: 'sandboxed' },
    tools: { mode: 'none' },
    session: { mode: 'ephemeral', scope: 'session' },
    ...overrides,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('SubsystemRuntime.consumePendingGuidance', () => {
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

  it('returns undefined when queues empty', () => {
    expect(runtime.consumePendingGuidance()).toBeUndefined();
  });

  it('formats steering and escalate with escalate first', async () => {
    runtime.register(
      makeSpec({
        think: {
          strategy: 'deterministic',
          implementation: 'code',
          handler: async () => ({
            signals: [
              { action: 'suggest', reason: 'soft hint', confidence: 0.5 },
              { action: 'escalate', reason: 'hard stop needed', confidence: 1 },
            ],
          }),
        },
        signal: { severity: 'critical', channel: ['steering', 'escalate'] },
      }),
    );

    await runtime.trigger('guidance-sub');
    const text = runtime.consumePendingGuidance();

    expect(text).toBeDefined();
    expect(text).toContain('Subsystem escalation');
    expect(text).toContain('hard stop needed');
    expect(text).toContain('Subsystem steering');
    expect(text).toContain('soft hint');
    // escalate section appears before steering
    expect(text!.indexOf('escalation')).toBeLessThan(text!.indexOf('steering'));
  });

  it('consumes queue once (fire-once)', async () => {
    runtime.register(makeSpec());
    await runtime.trigger('guidance-sub');
    expect(runtime.consumePendingGuidance()).toBeDefined();
    expect(runtime.consumePendingGuidance()).toBeUndefined();
  });

  it('steering-only config does not fill escalate', async () => {
    runtime.register(
      makeSpec({
        signal: { severity: 'advisory', channel: ['steering'] },
        think: {
          strategy: 'deterministic',
          implementation: 'code',
          handler: async () => ({
            signals: [{ action: 'suggest', reason: 'only steer' }],
          }),
        },
      }),
    );
    await runtime.trigger('guidance-sub');
    const text = runtime.consumePendingGuidance();
    expect(text).toContain('Subsystem steering');
    expect(text).not.toContain('Subsystem escalation');
  });

  it('clears pendingCounts after consume', async () => {
    runtime.register(makeSpec());
    await runtime.trigger('guidance-sub');
    expect(runtime.signals.pendingCounts.steering + runtime.signals.pendingCounts.escalate).toBeGreaterThan(0);
    runtime.consumePendingGuidance();
    expect(runtime.signals.pendingCounts.steering).toBe(0);
    expect(runtime.signals.pendingCounts.escalate).toBe(0);
  });
});
