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

describe('MemoryExtractorBridge', () => {
  it('should emit bundle.ready and trigger subsystem when lifecycle recent+pending', async () => {
    const { events, runtime } = createRuntime();

    const memoryStore = new InMemoryMemoryStore();
    const { spec } = createMemoryExtractorSubsystem({ memoryStore });
    const regErrors = runtime.register(spec);
    expect(regErrors).toEqual([]);

    const bridge = new MemoryExtractorBridge(events, runtime);

    // 先发一条 turn.end，让 collector 有内容
    events.emit({
      type: 'turn.end',
      timestamp: Date.now(),
      agentId: 'a1',
      sessionId: 's1',
      data: { content: 'This is a long assistant message with a 总结 marker to trigger assistant_summary detection.' },
    });

    let bundleReady = false;
    const disposable = events.on('memory.extractor.bundle.ready', () => { bundleReady = true; });

    // 触发 recent+pending
    events.emit({
      type: 'session.lifecycle.updated',
      timestamp: Date.now(),
      agentId: 'a1',
      sessionId: 's1',
      data: {
        lifecycle: 'recent',
        extractionStatus: 'pending',
        lastInteractionAt: Date.now(),
      },
    });

    // 等待 runtime.trigger 异步路径
    await new Promise((r) => setTimeout(r, 20));

    expect(bundleReady).toBe(true);

    disposable.dispose();
    bridge.dispose();
    runtime.dispose();
  });
});
