import { describe, expect, it, vi } from 'vitest';
import { TriggerEngine, getPriority } from '../../src/harness/distributed/trigger.js';
import type { EventTrigger, ConditionTrigger, ThresholdTrigger, TriggerContext, TriggerRule } from '../../src/harness/distributed/trigger.js';

function createMockEvents() {
  const handlers = new Map<string, Function[]>();
  return {
    emit: vi.fn(),
    on: (type: string, handler: Function) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(handler);
      return { dispose: vi.fn() };
    },
    onAll: (handler: Function) => {
      if (!handlers.has('*')) handlers.set('*', []);
      handlers.get('*')!.push(handler);
      return { dispose: vi.fn() };
    },
  } as any;
}

describe('TriggerEngine', () => {
  it('evaluateRule: EventTrigger matches when eventData exists', () => {
    const engine = new TriggerEngine({ events: createMockEvents() });
    const rule: EventTrigger = { type: 'event', event: { type: 'test.event' } };
    const ctx: TriggerContext = { eventData: { type: 'test.event' } };
    expect(engine.evaluateRule(rule, ctx)).toBe(true);
  });

  it('evaluateRule: EventTrigger does not match when eventData is undefined', () => {
    const engine = new TriggerEngine({ events: createMockEvents() });
    const rule: EventTrigger = { type: 'event', event: { type: 'test.event' } };
    const ctx: TriggerContext = {};
    expect(engine.evaluateRule(rule, ctx)).toBe(false);
  });

  it('evaluateRule: EventTrigger with filter', () => {
    const engine = new TriggerEngine({ events: createMockEvents() });
    const rule: EventTrigger = {
      type: 'event',
      event: { type: 'test', filter: (data: any) => data.value > 10 },
    };
    expect(engine.evaluateRule(rule, { eventData: { value: 5 } })).toBe(false);
    expect(engine.evaluateRule(rule, { eventData: { value: 15 } })).toBe(true);
  });

  it('evaluateRule: ThresholdTrigger', () => {
    const engine = new TriggerEngine({ events: createMockEvents() });
    const rule: ThresholdTrigger = {
      type: 'threshold',
      threshold: { metric: 'token_count', operator: '>', value: 80000 },
    };
    expect(engine.evaluateRule(rule, { metrics: { token_count: 50000 } })).toBe(false);
    expect(engine.evaluateRule(rule, { metrics: { token_count: 90000 } })).toBe(true);
    expect(engine.evaluateRule(rule, { metrics: {} })).toBe(false);
  });

  it('evaluateRule: ThresholdTrigger with all operators', () => {
    const engine = new TriggerEngine({ events: createMockEvents() });
    const ops: Array<{ op: '>' | '<' | '>=' | '<=' | '=='; value: number; expected: boolean }> = [
      { op: '>', value: 100, expected: false },   // 100 > 100 = false
      { op: '>', value: 50, expected: true },      // 100 > 50 = true
      { op: '<', value: 100, expected: false },    // 100 < 100 = false
      { op: '<', value: 200, expected: true },     // 100 < 200 = true
      { op: '>=', value: 100, expected: true },    // 100 >= 100 = true
      { op: '<=', value: 100, expected: true },    // 100 <= 100 = true
      { op: '==', value: 100, expected: true },    // 100 == 100 = true
    ];
    for (const { op, value, expected } of ops) {
      const rule: ThresholdTrigger = {
        type: 'threshold',
        threshold: { metric: 'x', operator: op, value },
      };
      expect(engine.evaluateRule(rule, { metrics: { x: 100 } })).toBe(expected);
    }
  });

  it('evaluateRule: ConditionTrigger', () => {
    const engine = new TriggerEngine({ events: createMockEvents() });
    const rule: ConditionTrigger = {
      type: 'condition',
      condition: { check: (ctx) => (ctx.tokenCount ?? 0) > 50000 },
    };
    expect(engine.evaluateRule(rule, { tokenCount: 30000 })).toBe(false);
    expect(engine.evaluateRule(rule, { tokenCount: 60000 })).toBe(true);
  });

  it('evaluateRules returns matched indices', () => {
    const engine = new TriggerEngine({ events: createMockEvents() });
    const rules: TriggerRule[] = [
      { type: 'threshold', threshold: { metric: 'x', operator: '>', value: 100 } },
      { type: 'threshold', threshold: { metric: 'x', operator: '<', value: 50 } },
      { type: 'threshold', threshold: { metric: 'x', operator: '>', value: 50 } },
    ];
    const matched = engine.evaluateRules(rules, { metrics: { x: 75 } });
    expect(matched).toEqual([2]); // only index 2 matches (x > 50)
  });

  it('updateMetric and getMetrics', () => {
    const engine = new TriggerEngine({ events: createMockEvents() });
    engine.updateMetric('token_count', 50000);
    engine.updateMetric('turn_count', 3);
    const metrics = engine.getMetrics();
    expect(metrics.token_count).toBe(50000);
    expect(metrics.turn_count).toBe(3);
  });

  it('dispose cleans up listeners and timers', () => {
    const events = createMockEvents();
    const engine = new TriggerEngine({ events });
    engine.onEvent('test', () => {});
    engine.onAllEvents(() => {});
    expect(() => engine.dispose()).not.toThrow();
  });
});

describe('getPriority', () => {
  it('intercept has highest priority (lowest number)', () => {
    expect(getPriority('intercept')).toBeLessThan(getPriority('replace_context'));
    expect(getPriority('replace_context')).toBeLessThan(getPriority('inject_context'));
    expect(getPriority('inject_context')).toBeLessThan(getPriority('notify'));
  });

  it('unknown mode returns 99', () => {
    expect(getPriority('unknown')).toBe(99);
  });
});
