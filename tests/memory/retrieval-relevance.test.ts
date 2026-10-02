/**
 * 检索相关性地板 + 混合排序 — 回归：无关 query 不得填满 limit
 *
 * 场景对齐实测：问「附子/炖肉」不得召回 110/技术选型等高 importance 项目记忆。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentDatabase } from '@octopi-agent/engine/harness/memory/sqlite/agent-db.js';
import { SqliteMemoryStore } from '@octopi-agent/engine/harness/memory/sqlite/memory-store.js';
import { InMemoryMemoryStore } from '@octopi-agent/engine/harness/memory/store.js';
import { MemoryLayer } from '@octopi-agent/engine/harness/context/layers.js';
import type { EmbeddingProvider } from '@octopi-agent/engine/harness/memory/sqlite/embedding.js';
import {
  DEFAULT_MIN_KEYWORD_SCORE,
  DEFAULT_MIN_SIMILARITY,
  blendRank,
  qualityScore,
} from '@octopi-agent/engine/harness/memory/retrieval-rank.js';

/** 主题正交向量：低相似度可预期，不依赖真实 embedding 服务 */
function createTopicEmbedding(dimensions = 8): EmbeddingProvider {
  const topics: Array<{ key: string; basis: number }> = [
    { key: '附子', basis: 0 },
    { key: '炖肉', basis: 0 },
    { key: '中药', basis: 0 },
    { key: '110', basis: 1 },
    { key: '方言', basis: 1 },
    { key: '语音', basis: 1 },
    { key: '技术选型', basis: 2 },
    { key: '框架', basis: 2 },
    { key: 'octopi', basis: 3 },
    { key: '研发', basis: 3 },
    { key: 'vitest', basis: 4 },
    { key: 'mock', basis: 4 },
    { key: '记忆', basis: 5 },
    { key: '检索', basis: 5 },
    { key: '技术栈', basis: 2 },
    { key: '选型', basis: 2 },
  ];
  const embed = (text: string): number[] => {
    const vec = new Array(dimensions).fill(0);
    const lower = text.toLowerCase();
    for (const t of topics) {
      if (lower.includes(t.key.toLowerCase())) {
        vec[t.basis % dimensions] += 1;
      }
    }
    // 无主题命中：固定噪声维，彼此接近但与主题轴正交偏弱
    if (vec.every((v) => v === 0)) {
      vec[dimensions - 1] = 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return norm > 0 ? vec.map((v) => v / norm) : vec;
  };
  return {
    name: 'topic-mock',
    dimensions,
    embed: async (text: string) => embed(text),
    embedBatch: async (texts: string[]) => texts.map(embed),
  };
}

describe('qualityScore / blendRank', () => {
  it('ranks higher similarity above higher quality when weight dominates', () => {
    const close = blendRank(0.9, 0.3, 0.65);
    const importantButFar = blendRank(0.2, 1.0, 0.65);
    expect(close).toBeGreaterThan(importantButFar);
    expect(qualityScore({ importance: 1, confidence: 1, decayFactor: 1 })).toBe(1);
  });
});

describe('SqliteMemoryStore vector relevance floor', () => {
  let db: AgentDatabase;
  let store: SqliteMemoryStore;

  beforeEach(async () => {
    db = await AgentDatabase.create({ dbPath: ':memory:' });
    store = new SqliteMemoryStore(db, {
      embeddingProvider: createTopicEmbedding(),
      vectorEngine: 'js',
    });
  });

  afterEach(() => {
    db.close();
  });

  async function seedUnrelatedHighQuality() {
    await store.store({
      type: 'norm',
      content: '110 接警语音转写方案必须突出云南方言识别率核心痛点',
      source: 's',
      confidence: 0.95,
      importance: 0.95,
      tags: ['110', '方言'],
      status: 'active',
      channel: 'user_directive',
      futureUse: '修订 110 语音转写方案时',
      evidence: 'quote:必须突出方言痛点',
    });
    await store.store({
      type: 'norm',
      content: '技术选型应多种技术都考虑，不局限于单一语言或框架',
      source: 's',
      confidence: 0.95,
      importance: 0.95,
      tags: ['技术选型', '框架'],
      status: 'active',
      channel: 'user_directive',
      futureUse: '技术选型时',
      evidence: 'quote:多种技术都考虑',
    });
    await store.store({
      type: 'fact',
      content: 'octopi 处于内部快速研发期，尚未对外正式发布',
      source: 's',
      confidence: 0.9,
      importance: 0.9,
      tags: ['octopi', '研发'],
      status: 'active',
      channel: 'decision',
      evidence: 'quote:内部快速研发期',
    });
  }

  it('unrelated query returns empty instead of filling top-k', async () => {
    await seedUnrelatedHighQuality();
    const results = await store.retrieve({
      text: '附子 是什么？炖肉吃有什么好处和危害？',
      limit: 5,
      updateAccess: false,
    });
    expect(results).toEqual([]);
  });

  it('related query still returns the matching memory', async () => {
    await seedUnrelatedHighQuality();
    const results = await store.retrieve({
      text: '110 方言识别率痛点怎么写进方案？',
      limit: 5,
      updateAccess: false,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('110');
  });

  it('prefers related over high-quality when both pass floor', async () => {
    await store.store({
      type: 'fact',
      content: '附子炖肉需注意炮制与剂量，生品有毒',
      source: 's',
      confidence: 0.7,
      importance: 0.5,
      tags: ['附子'],
      status: 'active',
      channel: 'decision',
      evidence: 'quote:生品有毒',
    });
    await store.store({
      type: 'norm',
      content: '110 接警语音转写方案必须突出方言痛点',
      source: 's',
      confidence: 0.95,
      importance: 0.95,
      tags: ['110'],
      status: 'active',
      channel: 'user_directive',
      evidence: 'quote:必须突出',
    });

    const results = await store.retrieve({
      text: '附子炖肉有什么危害？',
      limit: 5,
      updateAccess: false,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('附子');
  });

  it('empty query does not dump the library', async () => {
    await seedUnrelatedHighQuality();
    const results = await store.retrieve({ text: '   ', limit: 10, updateAccess: false });
    expect(results).toEqual([]);
  });

  it('minSimilarity=0 still available for active search browsing', async () => {
    await seedUnrelatedHighQuality();
    const results = await store.retrieve({
      text: '随便问问无关主题',
      limit: 5,
      updateAccess: false,
      minSimilarity: 0,
      minKeywordScore: 0,
    });
    // 放宽后可返回近邻；自动注入路径则用默认地板
    expect(results.length).toBeGreaterThan(0);
  });

  it('vector path does not keyword-fill when all sims are below floor', async () => {
    await seedUnrelatedHighQuality();
    // 同时写入会与 query 共享弱 keyword 的条目：向量地板应拒绝，且不得用关键词回填
    await store.store({
      type: 'fact',
      content: '这里提到什么好处与危害等字样但主题无关',
      source: 's',
      confidence: 0.9,
      importance: 0.9,
      tags: ['什么', '好处'],
      status: 'active',
      channel: 'admin',
      evidence: 'quote:什么好处',
    });
    const results = await store.retrieve({
      text: '附子 是什么？炖肉吃有什么好处和危害？',
      limit: 5,
      updateAccess: false,
    });
    expect(results).toEqual([]);
  });
});

describe('SqliteMemoryStore keyword floor', () => {
  let db: AgentDatabase;
  let store: SqliteMemoryStore;

  beforeEach(async () => {
    db = await AgentDatabase.create({ dbPath: ':memory:' });
    store = new SqliteMemoryStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('unrelated Chinese query returns empty on keyword path', async () => {
    await store.store({
      type: 'norm',
      content: '110 接警语音转写方案必须突出核心痛点',
      source: 's',
      confidence: 0.9,
      importance: 0.9,
      tags: ['110'],
      status: 'active',
      channel: 'user_directive',
      futureUse: '修订 110 方案时',
      evidence: 'quote:突出痛点',
    });
    const results = await store.retrieve({
      text: '附子 是什么？炖肉吃有什么好处和危害？',
      limit: 5,
      updateAccess: false,
    });
    expect(results).toEqual([]);
  });

  it('rejects single weak field hit below minKeywordScore', async () => {
    await store.store({
      type: 'fact',
      content: '完全无关的库存事实',
      source: 's',
      confidence: 0.5,
      importance: 0.5,
      tags: [],
      status: 'active',
      channel: 'admin',
      evidence: '危',
    });
    // 「危害」二元组「危害」不命中；弱 evidence 单字也不足以过默认地板
    const results = await store.retrieve({
      text: '危害',
      limit: 5,
      updateAccess: false,
      minKeywordScore: 2,
    });
    expect(results).toEqual([]);
  });
});

describe('InMemoryMemoryStore keyword floor', () => {
  it('does not fill on empty tokens', async () => {
    const store = new InMemoryMemoryStore();
    await store.store({
      type: 'fact',
      content: '无关事实',
      source: 's',
      confidence: 0.9,
      importance: 0.9,
      tags: [],
      status: 'active',
      channel: 'admin',
      evidence: 'e',
    });
    const results = await store.retrieve({ text: '附子 炖肉', limit: 5, updateAccess: false });
    expect(results).toEqual([]);
  });
});

describe('MemoryLayer auto-inject', () => {
  it('skips layer when retrieve is empty (unrelated task)', async () => {
    const db = await AgentDatabase.create({ dbPath: ':memory:' });
    const store = new SqliteMemoryStore(db, {
      embeddingProvider: createTopicEmbedding(),
      vectorEngine: 'js',
    });
    await store.store({
      type: 'norm',
      content: '110 接警方案必须突出方言识别率痛点',
      source: 's',
      confidence: 0.95,
      importance: 0.95,
      tags: ['110'],
      status: 'active',
      channel: 'user_directive',
      evidence: 'quote:必须突出',
    });

    const layer = new MemoryLayer({ store, limit: 5 });
    const content = await layer.assemble({
      sessionId: 's1',
      messages: [{ role: 'user', content: '附子 是什么？炖肉吃有什么好处和危害？' }],
      query: '附子 是什么？炖肉吃有什么好处和危害？',
      tokenBudget: 2000,
      systemBudget: 8000,
    });
    expect(content).toBeNull();
    db.close();
  });

  it('injects only relevant memories under the header', async () => {
    const db = await AgentDatabase.create({ dbPath: ':memory:' });
    const store = new SqliteMemoryStore(db, {
      embeddingProvider: createTopicEmbedding(),
      vectorEngine: 'js',
    });
    await store.store({
      type: 'fact',
      content: '附子入药需炮制，生品有大毒',
      source: 's',
      confidence: 0.8,
      importance: 0.7,
      tags: ['附子'],
      status: 'active',
      channel: 'decision',
      evidence: 'quote:生品有大毒',
    });

    const layer = new MemoryLayer({ store, limit: 5 });
    const content = await layer.assemble({
      sessionId: 's1',
      messages: [{ role: 'user', content: '附子是什么？' }],
      query: '附子是什么？',
      tokenBudget: 2000,
      systemBudget: 8000,
    });
    expect(content).not.toBeNull();
    expect(content!.text).toContain('相关记忆');
    expect(content!.text).toContain('附子');
    db.close();
  });
});

describe('default floor', () => {
  it('exposes 0.35 default and keyword floor 3', () => {
    expect(DEFAULT_MIN_SIMILARITY).toBe(0.35);
    expect(DEFAULT_MIN_KEYWORD_SCORE).toBe(3);
  });
});
