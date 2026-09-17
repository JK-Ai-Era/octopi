/**
 * WS 广播剥离 layer content 的辅助行为（纯函数语义，经 snapshot 对照）
 */

import { describe, it, expect } from 'vitest';
import { buildContextLayersSnapshot } from '../../src/harness/context/layer-snapshot.js';
import type { AssembleManifest } from '../../src/harness/context/layer-types.js';

/** 与 gateway stripLayerContentFromEvent 相同的剥离逻辑 */
function stripManifestContent(manifest: AssembleManifest): AssembleManifest {
  return {
    ...manifest,
    layers: manifest.layers.map(({ content: _c, ...rest }) => rest),
  };
}

describe('WS strip layer content', () => {
  it('剥离后 snapshot 无 content，但状态仍在', () => {
    const manifest: AssembleManifest = {
      sessionId: 's1',
      systemBudget: 1000,
      usedTokens: 100,
      shares: {},
      layers: [
        {
          id: 'persona',
          included: true,
          tokens: 100,
          priority: 100,
          order: 20,
          droppable: false,
          content: '# secret persona',
          preview: '# secret…',
        },
      ],
    };
    const full = buildContextLayersSnapshot({ manifest });
    expect(full.layers.find((l) => l.id === 'persona')?.content).toContain('secret');

    const stripped = buildContextLayersSnapshot({
      manifest: stripManifestContent(manifest),
    });
    const p = stripped.layers.find((l) => l.id === 'persona');
    expect(p?.content).toBeUndefined();
    expect(p?.preview).toBeTruthy();
    expect(p?.included).toBe(true);
  });
});
