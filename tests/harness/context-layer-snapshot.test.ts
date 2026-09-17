/**
 * buildContextLayersSnapshot — manifest → UI 快照
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_LAYER_IDS,
  buildContextLayersSnapshot,
  deriveLayerStatus,
  emptyContextLayersSnapshot,
} from '../../src/harness/context/layer-snapshot.js';
import type { AssembleManifest } from '../../src/harness/context/layer-types.js';

function manifest(partial?: Partial<AssembleManifest>): AssembleManifest {
  return {
    sessionId: 's1',
    systemBudget: 8000,
    structureReserve: 50,
    usedTokens: 3000,
    shares: { persona: 0.5, memory: 0.2, runtime: 0.3 },
    layers: [
      { id: 'persona', included: true, tokens: 2400, budgetTokens: 2800, priority: 100, order: 20 },
      { id: 'memory', included: false, tokens: 0, budgetTokens: 800, priority: 30, order: 60, reason: 'empty' },
      {
        id: 'runtime',
        included: false,
        tokens: 0,
        budgetTokens: 900,
        priority: 80,
        order: 70,
        reason: 'system budget exhausted (used=7200, need=400)',
      },
    ],
    ...partial,
  };
}

describe('buildContextLayersSnapshot', () => {
  it('始终输出七层，未注册层标 unregistered', () => {
    const snap = buildContextLayersSnapshot({ manifest: manifest(), assembledAt: 1 });
    expect(snap.layers).toHaveLength(ALL_LAYER_IDS.length);
    const wisdom = snap.layers.find((l) => l.id === 'wisdom');
    expect(wisdom?.status).toBe('unregistered');
    const persona = snap.layers.find((l) => l.id === 'persona');
    expect(persona?.status).toBe('included');
    expect(persona?.tokens).toBe(2400);
  });

  it('empty / dropped / error 状态可区分', () => {
    const m = manifest({
      layers: [
        { id: 'skill', included: false, tokens: 0, priority: 60, order: 30, reason: 'empty' },
        {
          id: 'knowledge',
          included: false,
          tokens: 0,
          priority: 40,
          order: 40,
          reason: 'system budget exhausted',
        },
        {
          id: 'memory',
          included: false,
          tokens: 0,
          priority: 30,
          order: 60,
          reason: 'assemble failed: sqlite busy',
        },
      ],
    });
    const snap = buildContextLayersSnapshot({ manifest: m, enabledLayerIds: ['skill', 'knowledge', 'memory'] });
    expect(snap.layers.find((l) => l.id === 'skill')?.status).toBe('empty');
    expect(snap.layers.find((l) => l.id === 'knowledge')?.status).toBe('dropped');
    expect(snap.layers.find((l) => l.id === 'memory')?.status).toBe('error');
  });

  it('included + 告警 reason 仍为 included', () => {
    const entry = {
      id: 'persona' as const,
      included: true,
      tokens: 100,
      priority: 100,
      order: 20,
      reason: 'system budget exhausted but kept (droppable=false)',
    };
    expect(deriveLayerStatus(entry)).toBe('included');
  });

  it('manifest.droppable 透传（不再仅按 persona 推断）', () => {
    const m = manifest({
      layers: [
        {
          id: 'runtime',
          included: true,
          tokens: 10,
          priority: 80,
          order: 70,
          droppable: false,
        },
      ],
    });
    const snap = buildContextLayersSnapshot({ manifest: m });
    expect(snap.layers.find((l) => l.id === 'runtime')?.droppable).toBe(false);
  });

  it('manifest.content 透传到 snapshot.layers', () => {
    const m = manifest({
      layers: [
        {
          id: 'persona',
          included: true,
          tokens: 10,
          priority: 100,
          order: 20,
          content: '# Persona\nYou are test.',
        },
      ],
    });
    const snap = buildContextLayersSnapshot({ manifest: m });
    expect(snap.layers.find((l) => l.id === 'persona')?.content).toContain('You are test.');
  });
});

describe('emptyContextLayersSnapshot', () => {
  it('七层均为 idle', () => {
    const snap = emptyContextLayersSnapshot('s2');
    expect(snap.sessionId).toBe('s2');
    expect(snap.layers.every((l) => l.status === 'idle')).toBe(true);
  });
});
