import { describe, it, expect } from 'vitest';
import { DefaultEventBus } from '../../../src/core/primitives/event-bus.js';
import { SubsystemRuntime } from '../../../src/harness/autonomous-subsystem/runtime.js';
import { MemoryExtractorBridge } from '../../../src/harness/memory/extraction/memory-extractor-bridge.js';
import { createMemoryExtractorSubsystem } from '../../../src/harness/memory/extraction/memory-extractor-subsystem.js';
import { InMemoryMemoryStore } from '../../../src/harness/memory/store.js';

function createRuntime() {
  const events = new DefaultEventBus({ debug: false });
  const runtime = new SubsystemRuntime({
    deps: {
      model: {
        async chat() { return { role: 'assistant', content: 'noop' } as any; },
        async stream() { return (async function*(){ yield { type: 'delta', delta: '' }; })(); },
      } as any,
      events,
      errorStrategy: { classify: () => 'unknown', shouldRetry: () => false, backoffMs: () => 0 },
      mainTools: new Map(),
    },
  });
  return { events, runtime };
}

describe('MemoryExtractorBridge observability events', () => {
  it('should emit lifecycle.matched/hit and trigger events', async () => {
    const { events, runtime } = createRuntime();
    const memoryStore = new InMemoryMemoryStore();
    const { spec } = createMemoryExtractorSubsystem({ memoryStore });
    runtime.register(spec);

    const bridge = new MemoryExtractorBridge(events, runtime);

    events.emit({
      type: 'turn.end',
      timestamp: Date.now(),
      agentId: 'a1',
      sessionId: 's1',
      data: { content: 'This is a long assistant message with a 总结 marker to trigger assistant_summary detection.' },
    });

    const emitted: string[] = [];
    const d = events.onAll((e) => {
      if (e.type.startsWith('memory.bridge.')) emitted.push(e.type);
    });

    events.emit({
      type: 'session.lifecycle.updated',
      timestamp: Date.now(),
      agentId: 'a1',
      sessionId: 's1',
      data: { lifecycle: 'recent', extractionStatus: 'pending', lastInteractionAt: Date.now() },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(emitted).toContain('memory.bridge.lifecycle.matched');
    expect(emitted).toContain('memory.bridge.bundle.hit');
    expect(emitted).toContain('memory.bridge.trigger.start');

    d.dispose();
    bridge.dispose();
    runtime.dispose();
  });
});
