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

describe('PendingExtractor backoff', () => {
  it('should backoff on repeated failures and eventually mark error', async () => {
    const { events, runtime } = createEnv();
    const memoryStore = new InMemoryMemoryStore();
    const { spec } = createMemoryExtractorSubsystem({ memoryStore });
    runtime.register(spec);

    const store = new InMemoryExtractorStore();
    await store.appendEvents('a1', 's1', [
      { ts: Date.now(), type: 'tool_failure', sessionId: 's1', agentId: 'a1' },
    ]);
    await store.updateMeta('a1', 's1', { sessionId: 's1', agentId: 'a1', extractionStatus: 'pending' });

    // Monkey-patch runtime.trigger to fail
    const originalTrigger = runtime.trigger.bind(runtime);
    let calls = 0;
    (runtime as any).trigger = async (id: string) => {
      calls += 1;
      throw new Error('trigger failed');
    };

    const pending = new PendingExtractor(events, runtime, store, {
      agentId: 'a1',
      autoStart: false,
      baseRetryMs: 1,
      maxRetryMs: 2,
      maxRetries: 3,
    });

    // scan 1 -> fail (retry1)
    await pending.scan();
    expect(calls).toBe(1);
    let pendings = await store.listPending('a1');
    // still pending (no completed)
    expect(pendings.some((p) => p.sessionId === 's1')).toBe(true);

    // scan 2 -> should be skipped due to backoff
    await pending.scan();
    expect(calls).toBe(1);

    // wait a tiny bit for backoff window to pass
    await new Promise((r) => setTimeout(r, 5));

    // scan 3 -> fail again (backoff window passed)
    await pending.scan();
    expect(calls).toBe(2);

    // wait for next backoff window
    await new Promise((r) => setTimeout(r, 5));

    // scan 4 -> fail again -> should mark error after maxRetries reached
    await pending.scan();
    expect(calls).toBe(3);

    pendings = await store.listPending('a1');
    // now pending list should be empty (marked error)
    expect(pendings.some((p) => p.sessionId === 's1')).toBe(false);

    pending.dispose();
    runtime.dispose();
  });
});
