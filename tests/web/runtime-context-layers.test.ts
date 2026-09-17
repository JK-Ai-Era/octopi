/**
 * Web Runtime Store — context.layers.assembled + timeline
 */

import { describe, it, expect, vi } from 'vitest';
import { OctopiRuntimeStore } from '../../src/integration/web/runtime/store.js';
import type { OctopiClient, AgentEventEnvelope } from '../../src/integration/web/sdk/client.js';
import type { AssembleManifest } from '../../src/harness/context/layer-types.js';

function mockClient(): OctopiClient & { __emit(e: AgentEventEnvelope): void } {
  const listeners: Record<string, unknown> = {};
  return {
    on(list: Record<string, unknown>) {
      Object.assign(listeners, list);
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    updateOptions: vi.fn(),
    getSessionContextLayers: vi.fn(async () => null),
    getAgentContextHealth: vi.fn(async () => null),
    __emit(event: AgentEventEnvelope) {
      (listeners.onEvent as (s: string | undefined, e: AgentEventEnvelope) => void)?.('s1', event);
    },
  } as unknown as OctopiClient & { __emit(e: AgentEventEnvelope): void };
}

const manifest: AssembleManifest = {
  sessionId: 's1',
  systemBudget: 4000,
  structureReserve: 50,
  usedTokens: 1200,
  shares: { persona: 0.6, runtime: 0.4 },
  layers: [
    { id: 'persona', included: true, tokens: 1000, budgetTokens: 2370, priority: 100, order: 20 },
    { id: 'runtime', included: false, tokens: 0, budgetTokens: 1580, priority: 80, order: 70, reason: 'empty' },
  ],
};

describe('OctopiRuntimeStore context.layers.assembled', () => {
  it('写入 inspector.contextLayers 并展开七层', () => {
    const client = mockClient();
    const store = new OctopiRuntimeStore(client);

    client.__emit({
      type: 'context.layers.assembled',
      timestamp: 111,
      sessionId: 's1',
      data: {
        sessionId: 's1',
        manifest,
        enabledLayerIds: ['persona', 'runtime'],
        query: 'hello',
        assembledAt: 111,
      },
    } as AgentEventEnvelope);

    const layers = store.getState().chat.inspector.contextLayers;
    expect(layers?.sessionId).toBe('s1');
    expect(layers?.usedTokens).toBe(1200);
    expect(layers?.layers).toHaveLength(7);
    expect(layers?.layers.find((l) => l.id === 'persona')?.included).toBe(true);
    expect(layers?.layers.find((l) => l.id === 'wisdom')?.status).toBe('unregistered');
  });

  it('多轮装配追加 timeline 摘要', () => {
    const client = mockClient();
    const store = new OctopiRuntimeStore(client);

    for (let i = 0; i < 2; i++) {
      client.__emit({
        type: 'context.layers.assembled',
        timestamp: 100 + i,
        sessionId: 's1',
        data: {
          sessionId: 's1',
          manifest: { ...manifest, usedTokens: 1000 + i * 100 },
          enabledLayerIds: ['persona', 'runtime'],
          assembledAt: 100 + i,
        },
      } as AgentEventEnvelope);
    }

    const timeline = store.getState().chat.inspector.contextLayersTimeline;
    expect(timeline?.length).toBe(2);
    expect(timeline?.[0]?.included).toContain('persona');
    // runtime reason=empty → 不计入 dropped/error
    expect(timeline?.[0]?.dropped ?? []).not.toContain('persona');
  });
});
