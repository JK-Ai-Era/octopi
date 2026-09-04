import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SenseEngine } from '../../src/harness/autonomous-subsystem/sense/engine.js';
import { DefaultEventBus } from '../../src/core/primitives/event-bus.js';
import type { SubsystemSpec } from '../../src/harness/autonomous-subsystem/types.js';

function makeSpec(overrides?: Partial<SubsystemSpec>): SubsystemSpec {
  return {
    id: 'test-subsystem',
    name: 'Test',
    description: 'test',
    sense: { source: 'eventBus', filter: { events: ['test.event'] }, isolation: 'structured' },
    think: { strategy: 'deterministic', implementation: 'code', handler: async () => ({ signals: [] }) },
    act: { mode: 'none' },
    signal: { severity: 'info', channel: ['event'] },
    boundary: { visibility: 'structured', authority: 'observe', security: 'sandboxed' },
    tools: { mode: 'none' },
    session: { mode: 'ephemeral', scope: 'session' },
    ...overrides,
  };
}

describe('SenseEngine', () => {
  let events: DefaultEventBus;
  let engine: SenseEngine;

  beforeEach(() => {
    events = new DefaultEventBus();
    engine = new SenseEngine({ events, defaultCooldownMs: 100, maxDepth: 3 });
  });

  afterEach(() => {
    engine.dispose();
  });

  describe('basic event triggering', () => {
    it('triggers when event arrives with no condition', () => {
      const onTrigger = vi.fn();
      engine.register(makeSpec(), onTrigger);

      events.emit({ type: 'test.event', timestamp: Date.now(), data: { foo: 'bar' } });

      expect(onTrigger).toHaveBeenCalledTimes(1);
      const ctx = onTrigger.mock.calls[0][0];
      expect(ctx.eventData).toEqual({ foo: 'bar' });
    });

    it('does not trigger on unlistened event types', () => {
      const onTrigger = vi.fn();
      engine.register(makeSpec(), onTrigger);

      events.emit({ type: 'other.event', timestamp: Date.now() });

      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('does not trigger after unregister', () => {
      const onTrigger = vi.fn();
      engine.register(makeSpec(), onTrigger);
      engine.unregister('test-subsystem');

      events.emit({ type: 'test.event', timestamp: Date.now() });

      expect(onTrigger).not.toHaveBeenCalled();
    });
  });

  describe('condition expression evaluation', () => {
    it('triggers when condition is met', () => {
      const onTrigger = vi.fn();
      engine.register(makeSpec({
        sense: { source: 'eventBus', filter: { events: ['test.event'], condition: 'turn.count >= 5' }, isolation: 'structured' },
      }), onTrigger);

      engine.metricsStore.update('turn.count', 10);
      events.emit({ type: 'test.event', timestamp: Date.now() });

      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('does not trigger when condition is not met', () => {
      const onTrigger = vi.fn();
      engine.register(makeSpec({
        sense: { source: 'eventBus', filter: { events: ['test.event'], condition: 'turn.count >= 10' }, isolation: 'structured' },
      }), onTrigger);

      engine.metricsStore.update('turn.count', 5);
      events.emit({ type: 'test.event', timestamp: Date.now() });

      expect(onTrigger).not.toHaveBeenCalled();
    });

    it('modulo condition: turn.count % 10 === 0', async () => {
      const onTrigger = vi.fn();
      engine.register(makeSpec({
        sense: { source: 'eventBus', filter: { events: ['test.event'], condition: 'turn.count % 10 === 0' }, isolation: 'structured' },
      }), onTrigger);

      engine.metricsStore.update('turn.count', 9);
      events.emit({ type: 'test.event', timestamp: Date.now() });
      expect(onTrigger).toHaveBeenCalledTimes(0);

      engine.metricsStore.update('turn.count', 10);
      events.emit({ type: 'test.event', timestamp: Date.now() });
      expect(onTrigger).toHaveBeenCalledTimes(1);

      engine.metricsStore.update('turn.count', 19);
      events.emit({ type: 'test.event', timestamp: Date.now() });
      expect(onTrigger).toHaveBeenCalledTimes(1);

      await new Promise((r) => setTimeout(r, 150));

      engine.metricsStore.update('turn.count', 20);
      events.emit({ type: 'test.event', timestamp: Date.now() });
      expect(onTrigger).toHaveBeenCalledTimes(2);
    });

    it('missing metric causes condition to fail (safe default)', () => {
      const onTrigger = vi.fn();
      engine.register(makeSpec({
        sense: { source: 'eventBus', filter: { events: ['test.event'], condition: 'turn.count > 0' }, isolation: 'structured' },
      }), onTrigger);

      events.emit({ type: 'test.event', timestamp: Date.now() });

      expect(onTrigger).not.toHaveBeenCalled();
    });
  });

  describe('cooldown', () => {
    it('does not trigger during cooldown period (EventBus not penetrable)', () => {
      const onTrigger = vi.fn();
      engine.register(makeSpec(), onTrigger);

      events.emit({ type: 'test.event', timestamp: Date.now() });
      expect(onTrigger).toHaveBeenCalledTimes(1);

      events.emit({ type: 'test.event', timestamp: Date.now() });
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('triggers again after cooldown expires', async () => {
      const onTrigger = vi.fn();
      engine.register(makeSpec(), onTrigger);

      events.emit({ type: 'test.event', timestamp: Date.now() });
      expect(onTrigger).toHaveBeenCalledTimes(1);

      await new Promise((r) => setTimeout(r, 150));

      events.emit({ type: 'test.event', timestamp: Date.now() });
      expect(onTrigger).toHaveBeenCalledTimes(2);
    });
  });

  describe('API trigger (penetrates cooldown)', () => {
    it('API trigger works during cooldown', () => {
      const onTrigger = vi.fn();
      engine.register(makeSpec(), onTrigger);

      events.emit({ type: 'test.event', timestamp: Date.now() });
      expect(onTrigger).toHaveBeenCalledTimes(1);

      const result = engine.trigger('test-subsystem', {}, onTrigger);
      expect(result).toBe(true);
      expect(onTrigger).toHaveBeenCalledTimes(2);
    });

    it('API trigger returns false for unknown subsystem', () => {
      const onTrigger = vi.fn();
      const result = engine.trigger('nonexistent', {}, onTrigger);
      expect(result).toBe(false);
      expect(onTrigger).not.toHaveBeenCalled();
    });
  });

  describe('depth limit', () => {
    it('nested triggers respect maxDepth', () => {
      let callCount = 0;
      const onTrigger = vi.fn(() => {
        callCount++;
        if (callCount <= 5) {
          engine.trigger('test-subsystem', {}, onTrigger);
        }
      });
      engine.register(makeSpec(), onTrigger);

      engine.trigger('test-subsystem', {}, onTrigger);

      expect(callCount).toBeLessThanOrEqual(3);
    });
  });

  describe('multiple subsystems', () => {
    it('different subsystems trigger independently', () => {
      const onTriggerA = vi.fn();
      const onTriggerB = vi.fn();

      engine.register(makeSpec({ id: 'sub-a', sense: { source: 'eventBus', filter: { events: ['evt.a'] }, isolation: 'structured' } }), onTriggerA);
      engine.register(makeSpec({ id: 'sub-b', sense: { source: 'eventBus', filter: { events: ['evt.b'] }, isolation: 'structured' } }), onTriggerB);

      events.emit({ type: 'evt.a', timestamp: Date.now() });
      expect(onTriggerA).toHaveBeenCalledTimes(1);
      expect(onTriggerB).not.toHaveBeenCalled();

      events.emit({ type: 'evt.b', timestamp: Date.now() });
      expect(onTriggerB).toHaveBeenCalledTimes(1);
    });

    it('same event triggers multiple subsystems', () => {
      const onTriggerA = vi.fn();
      const onTriggerB = vi.fn();

      engine.register(makeSpec({ id: 'sub-a' }), onTriggerA);
      engine.register(makeSpec({ id: 'sub-b' }), onTriggerB);

      events.emit({ type: 'test.event', timestamp: Date.now() });

      expect(onTriggerA).toHaveBeenCalledTimes(1);
      expect(onTriggerB).toHaveBeenCalledTimes(1);
    });
  });
});
