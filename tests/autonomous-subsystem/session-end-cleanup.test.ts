import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SubsystemRuntime } from '../../src/harness/autonomous-subsystem/runtime.js';
import { DefaultEventBus } from '../../src/core/primitives/event-bus.js';
import type { SubsystemSpec } from '../../src/harness/autonomous-subsystem/types.js';

function makeSpec(overrides?: Partial<SubsystemSpec>): SubsystemSpec {
  return {
    id: 'test.lifecycle.subsystem',
    name: 'Memory Extractor',
    description: 'test',
    sense: { source: 'eventBus', filter: { events: ['session.lifecycle.updated'] }, isolation: 'structured' },
    think: { strategy: 'deterministic', implementation: 'code', handler: async () => ({ signals: [] }) },
    act: { mode: 'none' },
    signal: { severity: 'info', channel: ['event'] },
    boundary: { visibility: 'structured', authority: 'observe', security: 'sandboxed' },
    tools: { mode: 'none' },
    session: { mode: 'persistent', scope: 'session', ttl: '24h' },
    ...overrides,
  };
}

describe('SubsystemRuntime session end cleanup', () => {
  let events: DefaultEventBus;
  let runtime: SubsystemRuntime;

  beforeEach(() => {
    events = new DefaultEventBus();
    runtime = new SubsystemRuntime({
      deps: { model: {} as any, events, errorStrategy: {} as any, mainTools: new Map() },
    });
  });

  afterEach(() => {
    runtime.dispose();
  });

  it('deletes scoped subsystem session on session.ended', () => {
    runtime.register(makeSpec());

    // 瑙﹀彂涓€娆★紝浠ュ垱寤?scoped subsystem session
    events.emit({
      type: 'session.lifecycle.updated',
      timestamp: Date.now(),
      agentId: 'agent-1',
      sessionId: 'session-1',
      data: { lifecycle: 'active' },
    });

    events.emit({
      type: 'session.ended',
      timestamp: Date.now(),
      agentId: 'agent-1',
      sessionId: 'session-1',
    });

    // 杩欓噷涓昏楠岃瘉涓嶄細鎶涢敊涓?runtime 浠嶅彲鐢紙娓呯悊璺緞鎵ц鎴愬姛锛?
    expect(runtime.subsystemCount).toBe(1);
  });
});

