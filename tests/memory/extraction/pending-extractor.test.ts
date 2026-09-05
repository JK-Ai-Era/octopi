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

describe('PendingExtractor', () => {
  it('should scan pending sessions and trigger subsystem', async () => {
    const { events, runtime } = createEnv();
    const memoryStore = new InMemoryMemoryStore();
    const { spec } = createMemoryExtractorSubsystem({ memoryStore });
    runtime.register(spec);

    const store = new InMemoryExtractorStore();

    // seed pending meta + events
    await store.appendEvents('a1', 's1', [
      { ts: Date.now(), type: 'tool_failure', sessionId: 's1', agentId: 'a1' },
      { ts: Date.now(), type: 'fix_applied', sessionId: 's1', agentId: 'a1' },
      { ts: Date.now(), type: 'tool_failure', sessionId: 's1', agentId: 'a1' },
    ]);
    await store.updateMeta('a1', 's1', { sessionId: 's1', agentId: 'a1', extractionStatus: 'pending' });

    let bundleReady = false;
    const d = events.on('memory.extractor.bundle.ready', () => { bundleReady = true; });

    const pending = new PendingExtractor(events, runtime, store, { agentId: 'a1', autoStart: false });
    const count = await pending.scan();

    expect(count).toBe(1);
    expect(bundleReady).toBe(true);

    // after scan, meta should be completed
    const metas = await store.listPending('a1');
    expect(metas.length).toBe(0);

    d.dispose();
    pending.dispose();
    runtime.dispose();
  });
});
