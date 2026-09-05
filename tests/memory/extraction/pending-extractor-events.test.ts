import { describe, it, expect } from 'vitest';
import { DefaultEventBus } from '../../../src/core/primitives/event-bus.js';
import { SubsystemRuntime } from '../../../src/harness/autonomous-subsystem/runtime.js';
import { InMemoryExtractorStore } from '../../../src/harness/memory/extraction/extractor-store.js';
import { PendingExtractor } from '../../../src/harness/memory/extraction/pending-extractor.js';
import { createMemoryExtractorSubsystem } from '../../../src/harness/memory/extraction/memory-extractor-subsystem.js';
import { InMemoryMemoryStore } from '../../../src/harness/memory/store.js';

function createEnv() {
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

describe('PendingExtractor observability events', () => {
  it('should emit start/triggered/complete events', async () => {
    const { events, runtime } = createEnv();
    const memoryStore = new InMemoryMemoryStore();
    const { spec } = createMemoryExtractorSubsystem({ memoryStore });
    runtime.register(spec);

    const store = new InMemoryExtractorStore();
    await store.appendEvents('a1', 's1', [
      { ts: Date.now(), type: 'constraint_set', sessionId: 's1', agentId: 'a1', payload: { text: 'Use ESM' } },
    ]);
    await store.updateMeta('a1', 's1', { sessionId: 's1', agentId: 'a1', extractionStatus: 'pending' });

    const emitted: string[] = [];
    const d = events.onAll((e) => {
      if (e.type.startsWith('pending.extractor.')) emitted.push(e.type);
    });

    const pending = new PendingExtractor(events, runtime, store, { agentId: 'a1', autoStart: false });
    await pending.scan();

    expect(emitted).toContain('pending.extractor.scan.start');
    expect(emitted).toContain('pending.extractor.scan.session.triggered');
    expect(emitted).toContain('pending.extractor.scan.complete');

    d.dispose();
    pending.dispose();
    runtime.dispose();
  });
});
