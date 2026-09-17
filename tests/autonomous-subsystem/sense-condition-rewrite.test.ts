import { describe, it, expect, vi } from 'vitest';
import {
  SenseEngine,
  rewriteConditionExpression,
} from '../../src/harness/autonomous-subsystem/sense/engine.js';
import { DefaultEventBus } from '../../src/core/primitives/event-bus.js';
import type { SubsystemSpec } from '../../src/harness/autonomous-subsystem/types.js';

const MEMORY_CONDITION =
  "(sessionLifecycle === 'recent' && extractionStatus === 'pending') || (eventData?.bundle != null)";

function makeSpec(condition: string): SubsystemSpec {
  return {
    id: 'memory.extractor',
    name: 'Memory Extractor',
    description: 'test',
    sense: {
      source: 'eventBus',
      filter: {
        events: ['session.lifecycle.updated', 'memory.extractor.bundle.ready'],
        condition,
      },
      isolation: 'structured',
    },
    think: { strategy: 'deterministic', implementation: 'code', handler: async () => ({ signals: [] }) },
    act: { mode: 'inject' },
    signal: { severity: 'info', channel: ['event'] },
    boundary: { visibility: 'structured', authority: 'act', security: 'trusted' },
    tools: { mode: 'none' },
    session: { mode: 'ephemeral', scope: 'session' },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('rewriteConditionExpression', () => {
  it('keeps string literals and maps context fields', () => {
    const body = rewriteConditionExpression(MEMORY_CONDITION);
    expect(body).toContain("'recent'");
    expect(body).toContain("'pending'");
    expect(body).toContain('ctx.sessionLifecycle');
    expect(body).toContain('ctx.extractionStatus');
    expect(body).toContain('ctx.eventData?.bundle');
    expect(body).not.toContain("ctx.metrics['recent']");
  });

  it('maps metric keys with dots', () => {
    expect(rewriteConditionExpression('turn.count >= 5')).toBe('ctx.metrics["turn.count"] >= 5');
  });
});

describe('SenseEngine memory.extractor condition', () => {
  it('triggers on lifecycle recent+pending', async () => {
    const events = new DefaultEventBus();
    const engine = new SenseEngine({ events, defaultCooldownMs: 0 });
    const onTrigger = vi.fn();
    engine.register(makeSpec(MEMORY_CONDITION), onTrigger);

    events.emit({
      type: 'session.lifecycle.updated',
      timestamp: Date.now(),
      agentId: 'a1',
      sessionId: 's1',
      data: { lifecycle: 'recent', extractionStatus: 'pending' },
    });
    await flush();
    expect(onTrigger).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it('triggers on bundle.ready via eventData.bundle', async () => {
    const events = new DefaultEventBus();
    const engine = new SenseEngine({ events, defaultCooldownMs: 0 });
    const onTrigger = vi.fn();
    engine.register(makeSpec(MEMORY_CONDITION), onTrigger);

    events.emit({
      type: 'memory.extractor.bundle.ready',
      timestamp: Date.now(),
      agentId: 'a1',
      sessionId: 's1',
      data: { bundle: { sessionId: 's1', agentId: 'a1', events: [] } },
    });
    await flush();
    expect(onTrigger).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it('does not trigger on active lifecycle', async () => {
    const events = new DefaultEventBus();
    const engine = new SenseEngine({ events, defaultCooldownMs: 0 });
    const onTrigger = vi.fn();
    engine.register(makeSpec(MEMORY_CONDITION), onTrigger);

    events.emit({
      type: 'session.lifecycle.updated',
      timestamp: Date.now(),
      agentId: 'a1',
      sessionId: 's1',
      data: { lifecycle: 'active', extractionStatus: 'pending' },
    });
    await flush();
    expect(onTrigger).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('API trigger with eventData.bundle evaluates condition true', () => {
    const events = new DefaultEventBus();
    const engine = new SenseEngine({ events, defaultCooldownMs: 0 });
    const onTrigger = vi.fn();
    engine.register(makeSpec(MEMORY_CONDITION), onTrigger);

    const ok = engine.trigger(
      'memory.extractor',
      { eventData: { bundle: { sessionId: 's1' } }, sessionId: 's1', agentId: 'a1' },
      onTrigger,
    );
    expect(ok).toBe(true);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    engine.dispose();
  });
});
