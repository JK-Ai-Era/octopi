import { describe, it, expect } from 'vitest';
import { AgentBuilder } from '../../src/harness/agent-building/builder.js';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import { DefaultEventBus } from '../../src/core/primitives/event-bus.js';
import type { SubsystemSpec } from '../../src/harness/autonomous-subsystem/types.js';
import type { MemoryStore } from '../../src/harness/memory/types.js';

const stubModel = {
  name: 'stub',
  defaultModel: 'stub-model',
  getModelInfo: () => ({ id: 'stub-model', contextWindow: 32_000 }),
  getModelInfos: () => [{ id: 'stub-model', contextWindow: 32_000 }],
  isAvailable: async () => true,
  chat: async () => ({ role: 'assistant' as const, content: 'ok' }),
  stream: async function* () {
    yield { type: 'delta' as const, delta: '' };
  },
};

function memoryExtractorSpec(memoryStore: MemoryStore): SubsystemSpec {
  return {
    id: 'memory.extractor',
    name: 'Memory Extractor',
    description: 'test',
    sense: {
      source: 'eventBus',
      filter: {
        events: ['session.lifecycle.updated', 'memory.extractor.bundle.ready'],
        condition: "(sessionLifecycle === 'recent' && extractionStatus === 'pending') || (eventData?.bundle != null)",
      },
      isolation: 'structured',
    },
    think: {
      strategy: 'deterministic',
      implementation: 'code',
      handler: async (input: any) => {
        const bundle = input?.payload?.sessionExtractBundle;
        if (bundle?.events?.length) {
          await memoryStore.store({
            type: 'discovery',
            content: `extracted:${bundle.sessionId}:${bundle.events.length}`,
            source: `session:${bundle.sessionId}`,
            confidence: 0.9,
            importance: 0.9,
            tags: ['test'],
          });
        }
        return {
          act: { mode: 'inject' as const, status: 'success' as const, target: 'memory-store' },
          signals: [],
        };
      },
    },
    act: { mode: 'inject' },
    signal: { severity: 'info', channel: ['event'] },
    boundary: { visibility: 'structured', authority: 'act', security: 'trusted' },
    tools: { mode: 'none' },
    session: { mode: 'ephemeral', scope: 'session' },
    lifecycle: { maxConcurrent: 1 },
    runtimeInject: { requires: ['memoryStore'] },
  };
}

describe('AgentBuilder memory extraction wiring', () => {
  it('core mode does not create runner or extraction', async () => {
    const built = await new AgentBuilder()
      .model(stubModel)
      .build({ mode: 'core', autoLoadSubsystems: false });

    expect(built.agent).toBeDefined();
    expect(built.runner).toBeUndefined();
    expect(built.runtime).toBeUndefined();
    expect(built.memoryExtraction).toBeUndefined();
  });

  it('full mode wires bridge + pending extractor when memory.extractor registered', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const events = new DefaultEventBus();
    const built = await new AgentBuilder()
      .model(stubModel)
      .events(events)
      .memoryStore(memoryStore)
      .withSubsystem(memoryExtractorSpec(memoryStore))
      .build({
        autoLoadSubsystems: false,
        subsystemAllowlist: ['memory.extractor'],
        extractionScanIntervalMs: 50,
      });

    expect(built.runner).toBeDefined();
    expect(built.runtime).toBeDefined();
    expect(built.memoryExtraction).toBeDefined();
    expect(built.memoryExtraction?.bridge).toBeDefined();
    expect(built.memoryExtraction?.pendingExtractor).toBeDefined();

    built.memoryExtraction?.dispose();
  });

  it('denylist prevents memory.extractor registration and extraction wiring', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const events = new DefaultEventBus();
    const built = await new AgentBuilder()
      .model(stubModel)
      .events(events)
      .memoryStore(memoryStore)
      .withSubsystem(memoryExtractorSpec(memoryStore))
      .subsystemDenylist('memory.extractor')
      .build({ autoLoadSubsystems: false });

    expect(built.memoryExtraction).toBeUndefined();
  });

  it('allowlist only registers listed subsystems', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const events = new DefaultEventBus();
    const other: SubsystemSpec = {
      ...memoryExtractorSpec(memoryStore),
      id: 'other.subsystem',
      name: 'Other',
    };
    const built = await new AgentBuilder()
      .model(stubModel)
      .events(events)
      .memoryStore(memoryStore)
      .withSubsystem(memoryExtractorSpec(memoryStore))
      .withSubsystem(other)
      .build({
        autoLoadSubsystems: false,
        subsystemAllowlist: ['other.subsystem'],
      });

    expect(built.runtime?.subsystemCount).toBe(1);
    expect(built.memoryExtraction).toBeUndefined();
  });

  it('extracts memory after lifecycle recent+pending via registered subsystem', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const events = new DefaultEventBus();
    const built = await new AgentBuilder()
      .model(stubModel)
      .events(events)
      .memoryStore(memoryStore)
      .withSubsystem(memoryExtractorSpec(memoryStore))
      .build({
        autoLoadSubsystems: false,
        subsystemAllowlist: ['memory.extractor'],
        extractionScanIntervalMs: 30_000,
      });

    const bridge = built.memoryExtraction!;

    // 通过 EventBus 喂 turn + lifecycle，走 Bridge 真实路径
    events.emit({
      type: 'turn.end',
      timestamp: Date.now(),
      agentId: 'a1',
      sessionId: 's1',
      data: { content: '这是一段足够长的总结文本，包含 总结 关键词以产生 assistant_summary 事件。' },
    });
    events.emit({
      type: 'tool.exec.start',
      timestamp: Date.now(),
      agentId: 'a1',
      sessionId: 's1',
      data: { toolName: 'shell' },
    });
    events.emit({
      type: 'session.lifecycle.updated',
      timestamp: Date.now(),
      agentId: 'a1',
      sessionId: 's1',
      data: { lifecycle: 'recent', extractionStatus: 'pending' },
    });

    await new Promise((r) => setTimeout(r, 100));

    const stats = await memoryStore.stats();
    expect(stats.totalEntries).toBeGreaterThan(0);

    bridge.dispose();
  });

  it('does not auto-load subsystems when autoLoadSubsystems is false', async () => {
    const built = await new AgentBuilder()
      .model(stubModel)
      .build({ autoLoadSubsystems: false });

    expect(built.runtime).toBeUndefined();
    expect(built.memoryExtraction).toBeUndefined();
  });
});
