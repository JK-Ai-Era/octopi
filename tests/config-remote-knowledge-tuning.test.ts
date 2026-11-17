/**
 * A18 — manageLocal=false 时本地 Service 调参键无消费方：条件性未接线检测。
 */
import { describe, expect, it } from 'vitest';
import { detectRemoteIgnoredKnowledgeKeys } from '../src/config-schema/unwired-keys.js';

describe('detectRemoteIgnoredKnowledgeKeys', () => {
  it('manageLocal=false 且配了调参键 → 按规则顺序报告', () => {
    const raw = {
      knowledge: {
        service: { manageLocal: false, baseUrl: 'http://x', connectTimeoutMs: 5000 },
        embed: { embedBatch: 16 },
        index: { hybridKeyword: true },
        keywordWeight: 0.5,
        autoInject: { minScore: 0.3, maxChunks: 8 },
        hint: { minScore: 0.2 },
        catalog: { autoDescribe: true, maxEntries: 10 },
      },
    };
    expect(detectRemoteIgnoredKnowledgeKeys(raw)).toEqual([
      'knowledge.embed',
      'knowledge.index',
      'knowledge.keywordWeight',
      'knowledge.autoInject.minScore',
      'knowledge.hint.minScore',
      'knowledge.catalog.autoDescribe',
      'knowledge.service.connectTimeoutMs',
    ]);
  });

  it('本地托管（manageLocal 省略或 true）→ 不报', () => {
    expect(detectRemoteIgnoredKnowledgeKeys({ knowledge: { embed: { embedBatch: 8 } } })).toEqual([]);
    expect(
      detectRemoteIgnoredKnowledgeKeys({ knowledge: { service: { manageLocal: true }, embed: {} } }),
    ).toEqual([]);
  });

  it('网关侧消费键不误报（promotion / query / autoInject 预算 / catalog 展示）', () => {
    const raw = {
      knowledge: {
        service: { manageLocal: false },
        promotion: { metrics: { minHits: 2 } },
        query: { includePriorUserTurns: 1 },
        autoInject: { maxChunks: 5, budgetTokens: 100 },
        catalog: { maxEntries: 5, showProgress: 'exact' },
      },
    };
    expect(detectRemoteIgnoredKnowledgeKeys(raw)).toEqual([]);
  });

  it('空输入 / 无 knowledge 段 → []', () => {
    expect(detectRemoteIgnoredKnowledgeKeys(null)).toEqual([]);
    expect(detectRemoteIgnoredKnowledgeKeys({})).toEqual([]);
    expect(detectRemoteIgnoredKnowledgeKeys('x')).toEqual([]);
  });
});
