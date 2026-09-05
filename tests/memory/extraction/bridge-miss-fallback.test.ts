import { describe, it, expect } from 'vitest';
import { DefaultEventBus } from '../../../src/core/primitives/event-bus.js';
import { SubsystemRuntime } from '../../../src/harness/autonomous-subsystem/runtime.js';
import { MemoryExtractorBridge } from '../../../src/harness/memory/extraction/memory-extractor-bridge.js';
import { InMemoryExtractorStore } from '../../../src/harness/memory/extraction/extractor-store.js';
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

describe('bridge miss fallback', () => {
  it('should create pending record in store when bundle miss occurs', async () => {
    const { events, runtime } = createEnv();
    const memoryStore = new InMemoryMemoryStore();
    const { spec } = createMemoryExtractorSubsystem({ memoryStore });
    runtime.register(spec);

    const store = new InMemoryExtractorStore();

    // 不自动 attach，手动仅挂载 lifecycle 监听，确保 miss 路径可测
    const bridge = new MemoryExtractorBridge(events, runtime, { store, autoAttach: false });
    bridge.attach({ attachCollector: false });

    const emitted: string[] = [];
    const d = events.onAll((e) => {
      if (e.type.startsWith('memory.extractor.bridge.')) emitted.push(e.type);
    });

    // 触发 lifecycle recent+pending，但 collector 无 bundle → 应产生 miss 与 pending 记录
    events.emit({
      type: 'session.lifecycle.updated',
      timestamp: Date.now(),
      agentId: 'a1',
      sessionId: 's-miss-1',
      data: { lifecycle: 'recent', extractionStatus: 'pending', lastInteractionAt: Date.now() },
    });

    // 等待异步 store.updateMeta
    await new Promise((r) => setTimeout(r, 20));

    expect(emitted).toContain('memory.extractor.bridge.lifecycle.matched');
    // 精确断言：这里命中 miss 路径，不应包含 hit
    expect(emitted).not.toContain('memory.extractor.bridge.bundle.hit');

    const pendings = await store.listPending('a1');
    expect(pendings.some((p) => p.sessionId === 's-miss-1')).toBe(true);

    d.dispose();
    bridge.dispose();
    runtime.dispose();
  });
});
