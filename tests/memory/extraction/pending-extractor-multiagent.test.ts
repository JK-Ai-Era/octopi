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

describe('PendingExtractor multi-agent config', () => {
  it('should scan multiple agents independently', async () => {
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

    // seed two agents
    await store.appendEvents('a1', 's1', [{ ts: Date.now(), type: 'tool_failure', sessionId: 's1', agentId: 'a1' }, { ts: Date.now(), type: 'fix_applied', sessionId: 's1', agentId: 'a1' }, { ts: Date.now(), type: 'tool_failure', sessionId: 's1', agentId: 'a1' }]);
    await store.updateMeta('a1', 's1', { sessionId: 's1', agentId: 'a1', extractionStatus: 'pending' });

    await store.appendEvents('a2', 's2', [{ ts: Date.now(), type: 'constraint_set', sessionId: 's2', agentId: 'a2', payload: { text: 'No ORM' } }]);
    await store.updateMeta('a2', 's2', { sessionId: 's2', agentId: 'a2', extractionStatus: 'pending' });

    const ready: string[] = [];
    const d = events.on('memory.extractor.bundle.ready', (e) => { ready.push(e.sessionId as string); });

    const pending = new PendingExtractor(events, runtime, store, {
      autoStart: false,
      agentConfigs: [{ agentId: 'a1' }, { agentId: 'a2' }],
    });

    // call scanAgent directly for deterministic test
    await pending.scanAgent({ agentId: 'a1' });
    await pending.scanAgent({ agentId: 'a2' });

    expect(ready.sort()).toEqual(['s1', 's2']);

    d.dispose();
    pending.dispose();
    runtime.dispose();
  });
});
