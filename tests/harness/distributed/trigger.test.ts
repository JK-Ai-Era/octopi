/**
 * Tests for TriggerEngine and trigger rules
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TriggerEngine, getPriority } from '../../../src/harness/distributed/trigger.js';
import type {
  EventTrigger,
  ConditionTrigger,
  ThresholdTrigger,
  MessageTrigger,
  TriggerRule,
} from '../../../src/harness/distributed/trigger.js';
import type { TriggerContext } from '../../../src/harness/distributed/types.js';
import type { EventBus } from '../../../src/harness/distributed/../../core/event-bus.js';

function createMockEventBus(): EventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(() => ({ dispose: vi.fn() })),
    onAll: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

describe('TriggerEngine', () => {
  let engine: TriggerEngine;
  let mockEvents: EventBus;

  beforeEach(() => {
    mockEvents = createMockEventBus();
    engine = new TriggerEngine({ events: mockEvents });
  });

  describe('EventTrigger', () => {
    it('should match when eventData exists and no filter', () => {
      const rule: EventTrigger = {
        type: 'event',
        event: { type: 'tool_call.risk_unknown' },
      };

      const ctx: TriggerContext = {
        eventData: { type: 'tool_call.risk_unknown', toolName: 'shell' },
      };

      expect(engine.evaluateRule(rule, ctx)).toBe(true);
    });

    it('should not match when eventData is missing', () => {
      const rule: EventTrigger = {
        type: 'event',
        event: { type: 'tool_call.risk_unknown' },
      };

      const ctx: TriggerContext = {};

      expect(engine.evaluateRule(rule, ctx)).toBe(false);
    });

    it('should apply filter function', () => {
      const rule: EventTrigger = {
        type: 'event',
        event: {
          type: 'tool_call',
          filter: (data: unknown) => {
            const d = data as Record<string, unknown>;
            return d.risk === 'high';
          },
        },
      };

      expect(engine.evaluateRule(rule, { eventData: { risk: 'high' } })).toBe(true);
      expect(engine.evaluateRule(rule, { eventData: { risk: 'low' } })).toBe(false);
    });
  });

  describe('ConditionTrigger', () => {
    it('should evaluate check function', () => {
      const rule: ConditionTrigger = {
        type: 'condition',
        condition: {
          check: (ctx) => (ctx.tokenCount ?? 0) > 80000,
        },
      };

      expect(engine.evaluateRule(rule, { tokenCount: 90000 })).toBe(true);
      expect(engine.evaluateRule(rule, { tokenCount: 50000 })).toBe(false);
    });
  });

  describe('ThresholdTrigger', () => {
    it('should evaluate > operator', () => {
      const rule: ThresholdTrigger = {
        type: 'threshold',
        threshold: { metric: 'token_count', operator: '>', value: 80000 },
      };

      expect(engine.evaluateRule(rule, { metrics: { token_count: 90000 } })).toBe(true);
      expect(engine.evaluateRule(rule, { metrics: { token_count: 80000 } })).toBe(false);
      expect(engine.evaluateRule(rule, { metrics: { token_count: 70000 } })).toBe(false);
    });

    it('should evaluate < operator', () => {
      const rule: ThresholdTrigger = {
        type: 'threshold',
        threshold: { metric: 'memory', operator: '<', value: 100 },
      };

      expect(engine.evaluateRule(rule, { metrics: { memory: 50 } })).toBe(true);
      expect(engine.evaluateRule(rule, { metrics: { memory: 100 } })).toBe(false);
    });

    it('should evaluate >= operator', () => {
      const rule: ThresholdTrigger = {
        type: 'threshold',
        threshold: { metric: 'count', operator: '>=', value: 10 },
      };

      expect(engine.evaluateRule(rule, { metrics: { count: 10 } })).toBe(true);
      expect(engine.evaluateRule(rule, { metrics: { count: 11 } })).toBe(true);
      expect(engine.evaluateRule(rule, { metrics: { count: 9 } })).toBe(false);
    });

    it('should evaluate <= operator', () => {
      const rule: ThresholdTrigger = {
        type: 'threshold',
        threshold: { metric: 'count', operator: '<=', value: 10 },
      };

      expect(engine.evaluateRule(rule, { metrics: { count: 10 } })).toBe(true);
      expect(engine.evaluateRule(rule, { metrics: { count: 9 } })).toBe(true);
      expect(engine.evaluateRule(rule, { metrics: { count: 11 } })).toBe(false);
    });

    it('should evaluate == operator', () => {
      const rule: ThresholdTrigger = {
        type: 'threshold',
        threshold: { metric: 'status', operator: '==', value: 42 },
      };

      expect(engine.evaluateRule(rule, { metrics: { status: 42 } })).toBe(true);
      expect(engine.evaluateRule(rule, { metrics: { status: 43 } })).toBe(false);
    });

    it('should return false when metric is missing', () => {
      const rule: ThresholdTrigger = {
        type: 'threshold',
        threshold: { metric: 'missing', operator: '>', value: 0 },
      };

      expect(engine.evaluateRule(rule, { metrics: {} })).toBe(false);
    });

    it('should use internal metrics when ctx.metrics is not provided', () => {
      engine.updateMetric('token_count', 90000);

      const rule: ThresholdTrigger = {
        type: 'threshold',
        threshold: { metric: 'token_count', operator: '>', value: 80000 },
      };

      expect(engine.evaluateRule(rule, {})).toBe(true);
    });
  });

  describe('MessageTrigger', () => {
    it('should match message type', () => {
      const rule: MessageTrigger = {
        type: 'message',
        message: { type: 'task_complete' },
      };

      expect(engine.evaluateRule(rule, { eventData: { type: 'task_complete' } })).toBe(true);
      expect(engine.evaluateRule(rule, { eventData: { type: 'other' } })).toBe(false);
    });

    it('should match message from', () => {
      const rule: MessageTrigger = {
        type: 'message',
        message: { type: 'result', from: 'proc-123' },
      };

      expect(engine.evaluateRule(rule, { eventData: { type: 'result', from: 'proc-123' } })).toBe(true);
      expect(engine.evaluateRule(rule, { eventData: { type: 'result', from: 'proc-456' } })).toBe(false);
    });

    it('should return false when eventData is not an object', () => {
      const rule: MessageTrigger = {
        type: 'message',
        message: { type: 'test' },
      };

      expect(engine.evaluateRule(rule, { eventData: 'string' })).toBe(false);
      expect(engine.evaluateRule(rule, {})).toBe(false);
    });
  });

  describe('evaluateRules', () => {
    it('should return indices of matched rules', () => {
      const rules: TriggerRule[] = [
        { type: 'event', event: { type: 'no_match' } },
        { type: 'condition', condition: { check: () => true } },
        { type: 'threshold', threshold: { metric: 'x', operator: '>', value: 0 } },
      ];

      const matched = engine.evaluateRules(rules, { metrics: { x: 10 } });
      expect(matched).toContain(1);
      expect(matched).toContain(2);
      expect(matched).not.toContain(0);
    });

    it('should return empty array when no rules match', () => {
      const rules: TriggerRule[] = [
        { type: 'event', event: { type: 'no_match' } },
      ];

      const matched = engine.evaluateRules(rules, {});
      expect(matched).toEqual([]);
    });
  });

  describe('metrics', () => {
    it('should update and retrieve metrics', () => {
      engine.updateMetric('cpu', 75);
      engine.updateMetric('memory', 512);

      const metrics = engine.getMetrics();
      expect(metrics.cpu).toBe(75);
      expect(metrics.memory).toBe(512);
    });
  });

  describe('dispose', () => {
    it('should clean up all disposables and timers', () => {
      const mockDisposable = { dispose: vi.fn() };
      (mockEvents.onAll as ReturnType<typeof vi.fn>).mockReturnValue(mockDisposable);

      const freshEngine = new TriggerEngine({ events: mockEvents });
      freshEngine.onAllEvents(() => {});
      freshEngine.dispose();

      expect(mockDisposable.dispose).toHaveBeenCalled();
    });
  });
});

describe('getPriority', () => {
  it('should return correct priority values', () => {
    expect(getPriority('intercept')).toBe(0);
    expect(getPriority('replace_context')).toBe(1);
    expect(getPriority('inject_context')).toBe(2);
    expect(getPriority('notify')).toBe(3);
  });

  it('should return 99 for unknown modes', () => {
    expect(getPriority('unknown')).toBe(99);
  });
});
