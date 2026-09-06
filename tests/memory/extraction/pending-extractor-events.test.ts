import { describe, it, expect } from 'vitest';
import { DefaultEventBus } from '../../../src/core/primitives/event-bus.js';
import { SubsystemRuntime } from '../../../src/harness/autonomous-subsystem/runtime.js';
import { InMemoryExtractorStore } from '../../../src/harness/memory/extraction/extractor-store.js';
import { PendingExtractor } from '../../../src/harness/memory/extraction/pending-extractor.js';
import { callHandler } from '../../../src/subsystems/memory-extractor/handler.js';
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
    // 构建最小 SubsystemSpec 供 runtime 注册
    const spec: SubsystemSpec = {
      id: 'memory.extractor',
      name: 'Memory Extractor',
      description: 'test',
      sense: { source: 'eventBus', filter: { events: ['session.lifecycle.updated', 'memory.extractor.bundle.ready'], condition: "(sessionLifecycle === 'recent' && extractionStatus === 'pending') || (eventData?.bundle != null)" }, isolation: 'structured' },
      think: { strategy: 'deterministic', implementation: 'code', handler: (input: any) => callHandler(input, memoryStore) },
      act: { mode: 'inject' },
      signal: { severity: 'info', channel: ['context', 'event'] },
      boundary: { visibility: 'structured', authority: 'act', security: 'trusted' },
      tools: { mode: 'none' },
      session: { mode: 'ephemeral', scope: 'session' },
      lifecycle: { maxConcurrent: 1 },
    };
    runtime.register(spec);

    const store = new InMemoryExtractorStore();
    await store.appendEvents('a1', 's1', [
      { ts: Date.now(), type: 'constraint_set', sessionId: 's1', agentId: 'a1', payload: { text: 'Use ESM' } },
    ]);
    await store.updateMeta('a1', 's1', { sessionId: 's1', agentId: 'a1', extractionStatus: 'pending' });

    const emitted: string[] = [];
    const d = events.onAll((e) => {
      if (e.type.startsWith('memory.extractor.pending.')) emitted.push(e.type);
    });

    const pending = new PendingExtractor(events, runtime, store, { agentId: 'a1', autoStart: false });
    await pending.scan();

    expect(emitted).toContain('memory.extractor.pending.scan.start');
    expect(emitted).toContain('memory.extractor.pending.scan.session.triggered');
    expect(emitted).toContain('memory.extractor.pending.scan.complete');

    d.dispose();
    pending.dispose();
    runtime.dispose();
  });
});
