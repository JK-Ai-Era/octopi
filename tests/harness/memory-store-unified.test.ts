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

function extractorSpec(store: MemoryStore): SubsystemSpec {
  return {
    id: 'memory.extractor',
    name: 'Memory Extractor',
    description: 'test',
    sense: {
      source: 'eventBus',
      filter: {
        events: ['memory.extractor.bundle.ready'],
        condition: "eventData?.bundle != null",
      },
      isolation: 'structured',
    },
    think: {
      strategy: 'deterministic',
      implementation: 'code',
      handler: async (input: any) => {
        const bundle = input?.payload?.sessionExtractBundle;
        if (bundle?.events?.length) {
          await store.store({
            type: 'discovery',
            content: `extractor:${bundle.sessionId}`,
            source: `session:${bundle.sessionId}`,
            confidence: 0.9,
            importance: 0.9,
            tags: ['extract'],
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
    runtimeInject: { requires: ['memoryStore'] },
  };
}

describe('unified MemoryStore across tools / extract / layer source', () => {
  it('memory tools bind to the same store passed to AgentBuilder', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const built = await new AgentBuilder()
      .model(stubModel)
      .memoryStore(memoryStore)
      .build({ autoLoadSubsystems: false });

    const toolNames = (built.agent.tools ?? []).map((t: any) => t.name);
    expect(toolNames).toContain('memory_store');
    expect(toolNames).toContain('memory_search');

    const storeTool = built.agent.tools.find((t) => t.name === 'memory_store')!;
    const searchTool = built.agent.tools.find((t) => t.name === 'memory_search')!;
    const before = await memoryStore.stats();
    const storeResult = await storeTool.execute('call-1', {
      content: 'user prefers ESM',
      type: 'preference',
      confidence: 0.9,
      importance: 0.8,
    });
    expect(storeResult.isError).not.toBe(true);
    const after = await memoryStore.stats();
    expect(after.totalEntries).toBe(before.totalEntries + 1);

    const searchResult = await searchTool.execute('call-2', { query: 'ESM' });
    expect(searchResult.isError).not.toBe(true);
    const payload = searchResult.content as { total: number };
    expect(payload.total).toBeGreaterThanOrEqual(1);

    built.memoryExtraction?.dispose();
  });

  it('extractor writes land in the same store the tools read', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const events = new DefaultEventBus();
    const built = await new AgentBuilder()
      .model(stubModel)
      .events(events)
      .memoryStore(memoryStore)
      .withSubsystem(extractorSpec(memoryStore))
      .build({
        autoLoadSubsystems: false,
        subsystemAllowlist: ['memory.extractor'],
      });

    const tools = await import('../../src/harness/plugin-ecosystem/tools/memory.js');
    const [, searchTool] = tools.createMemoryTools(memoryStore);

    // 触发 extractor（bundle → 同一 store）
    const { runtime } = built;
    await runtime!.trigger('memory.extractor', {
      eventData: {
        bundle: {
          sessionId: 's-uni',
          agentId: 'a1',
          startAt: Date.now(),
          events: [{ ts: Date.now(), type: 'user_confirm', sessionId: 's-uni', payload: {} }],
          condensedTurns: [],
          runSummary: { totalTurns: 1, totalToolCalls: 0, failureRate: 0, majorErrors: [], resolvedErrors: [] },
        },
      },
      agentId: 'a1',
      sessionId: 's-uni',
    });

    const found = (await searchTool.handler(
      { query: 'extractor' },
      { sessionId: 's-uni', agentId: 'a1', messages: [] },
    )) as { total: number; results: Array<{ content: string }> };
    expect(found.total).toBeGreaterThanOrEqual(1);
    expect(found.results.some((r) => r.content.includes('extractor:s-uni'))).toBe(true);

    built.memoryExtraction?.dispose();
  });
});
