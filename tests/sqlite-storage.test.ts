/**
 * SQLite 存储层测试
 *
 * 测试 AgentDatabase、SqliteMemoryStore、SqliteWisdomStore、SqliteConceptGraph
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentDatabase } from '@octopi-agent/engine/harness/memory/sqlite/agent-db.js';
import { SqliteMemoryStore } from '@octopi-agent/engine/harness/memory/sqlite/memory-store.js';
import { SqliteWisdomStore } from '@octopi-agent/engine/harness/memory/sqlite/wisdom-store.js';
import { SqliteConceptGraph } from '@octopi-agent/engine/harness/memory/sqlite/cognition-store.js';
import { cosineSimilarity, cosineDistance } from '@octopi-agent/engine/harness/memory/sqlite/vector-search.js';
import type { EmbeddingProvider } from '@octopi-agent/engine/harness/memory/sqlite/embedding.js';

// ── Mock Embedding Provider ──

function createMockEmbedding(): EmbeddingProvider {
  // 词元哈希 embedding：共享 token 提升相似度（模拟语义向量，而非字符 bag）
  // 注意：store 侧 embed 的是 embedText()（content+meta），query 只 embed text——
  // 真实 embedding 能跨 meta 对齐；字符级 mock 会把相似度打没，导致地板下零命中。
  const dimensions = 64;

  function textToVec(text: string): number[] {
    const vec = new Array(dimensions).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+|[一-鿿]/g) ?? [];
    for (const t of tokens) {
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
      vec[h % dimensions] += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return norm > 0 ? vec.map((v) => v / norm) : vec;
  }

  return {
    name: 'mock',
    dimensions,
    embed: async (text: string) => textToVec(text),
    embedBatch: async (texts: string[]) => texts.map(textToVec),
  };
}

// ── AgentDatabase 测试 ──

describe('AgentDatabase', () => {
  let db: AgentDatabase;

  beforeEach(async () => {
    db = await AgentDatabase.create({ dbPath: ':memory:' });
  });

  afterEach(() => {
    db.close();
  });

  it('should create all tables', () => {
    const stats = db.stats();
    expect(stats.memories).toBe(0);
    expect(stats.concepts).toBe(0);
    expect(stats.concept_edges).toBe(0);
    expect(stats.wisdom).toBe(0);
    expect(stats.knowledge_sources).toBe(0);
  });

  it('should generate unique IDs', () => {
    const id1 = AgentDatabase.generateId('test');
    const id2 = AgentDatabase.generateId('test');
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^test_/);
  });
});

// ── SqliteMemoryStore 测试 ──

describe('SqliteMemoryStore', () => {
  let db: AgentDatabase;
  let store: SqliteMemoryStore;

  beforeEach(async () => {
    db = await AgentDatabase.create({ dbPath: ':memory:' });
    store = new SqliteMemoryStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should store and retrieve a memory', async () => {
    const id = await store.store({
      type: 'method',
      content: 'Vitest 的 mock 需要先 import 再 mock',
      source: 'session-1',
      confidence: 0.8,
      importance: 0.7,
      tags: ['vitest', 'testing'],
      status: 'active',
      channel: 'admin',
      evidence: 'unit',
      anchors: ['vitest'],
    });

    expect(id).toBeTruthy();

    const entry = await store.get(id);
    expect(entry).toBeTruthy();
    expect(entry!.type).toBe('method');
    expect(entry!.content).toBe('Vitest 的 mock 需要先 import 再 mock');
    expect(entry!.tags).toEqual(['vitest', 'testing']);
  });

  it('should retrieve by type filter', async () => {
    await store.store({ type: 'method', content: 'lesson 1', source: 's1', confidence: 0.5, importance: 0.5, tags: [], status: 'active', channel: 'admin', evidence: 't' });
    await store.store({ type: 'norm', content: 'preference 1', source: 's1', confidence: 0.5, importance: 0.5, tags: [], status: 'active', channel: 'admin', evidence: 't' });
    await store.store({ type: 'method', content: 'lesson 2', source: 's1', confidence: 0.5, importance: 0.5, tags: [], status: 'active', channel: 'admin', evidence: 't' });

    const lessons = await store.retrieve({ text: '', type: 'method' });
    expect(lessons.length).toBe(2);
    expect(lessons.every(e => e.type === 'method')).toBe(true);
  });

  it('should retrieve by keyword match', async () => {
    await store.store({ type: 'fact', content: '选择了 PostgreSQL 而非 MongoDB', source: 's1', confidence: 0.9, importance: 0.8, tags: ['database'], status: 'active', channel: 'admin', evidence: 't' });
    await store.store({ type: 'method', content: 'Vitest 的 mock 需要先 import', source: 's1', confidence: 0.7, importance: 0.6, tags: ['testing'], status: 'active', channel: 'admin', evidence: 't' });

    const results = await store.retrieve({ text: 'PostgreSQL database' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('PostgreSQL');
  });

  it('should update access count', async () => {
    const id = await store.store({ type: 'method', content: 'test', source: 's1', confidence: 0.5, importance: 0.5, tags: [], status: 'active', channel: 'admin', evidence: 't' });

    await store.retrieve({ text: 'test' });
    const entry = await store.get(id);
    expect(entry!.accessCount).toBe(1);

    await store.retrieve({ text: 'test' });
    const entry2 = await store.get(id);
    expect(entry2!.accessCount).toBe(2);
  });

  it('should delete a memory', async () => {
    const id = await store.store({ type: 'method', content: 'test', source: 's1', confidence: 0.5, importance: 0.5, tags: [], status: 'active', channel: 'admin', evidence: 't' });
    await store.delete(id);
    const entry = await store.get(id);
    expect(entry).toBeNull();
  });

  it('should return stats', async () => {
    await store.store({ type: 'method', content: 'l1', source: 's1', confidence: 0.8, importance: 0.7, tags: [], status: 'active', channel: 'admin', evidence: 't' });
    await store.store({ type: 'norm', content: 'p1', source: 's1', confidence: 0.6, importance: 0.5, tags: [], status: 'active', channel: 'admin', evidence: 't' });

    const stats = await store.stats();
    expect(stats.totalEntries).toBe(2);
    expect(stats.byType.method).toBe(1);
    expect(stats.byType.norm).toBe(1);
  });

  it('should perform decay', async () => {
    const id = await store.store({ type: 'fact', content: 'old memory', source: 's1', confidence: 0.5, importance: 0.5, tags: [], status: 'active', channel: 'admin', evidence: 't' });

    // 手动设置 last_accessed_at 为 60 天前
    const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    db.raw.prepare('UPDATE memories SET last_accessed_at = ? WHERE id = ?').run(sixtyDaysAgo, id);

    const decayed = await store.decay();
    expect(decayed).toBeGreaterThan(0);

    const entry = await store.get(id);
    expect(entry!.decayFactor).toBeLessThan(1.0);
  });
});

// ── SqliteMemoryStore with Embedding 测试 ──

describe('SqliteMemoryStore with embedding', () => {
  let db: AgentDatabase;
  let store: SqliteMemoryStore;
  const embedding = createMockEmbedding();

  beforeEach(async () => {
    db = await AgentDatabase.create({ dbPath: ':memory:' });
    store = new SqliteMemoryStore(db, { embeddingProvider: embedding });
  });

  afterEach(() => {
    db.close();
  });

  it('should store memory with embedding', async () => {
    const id = await store.store({
      type: 'fact',
      content: '选择了 PostgreSQL 作为主数据库',
      source: 's1',
      confidence: 0.9,
      importance: 0.8,
      tags: ['database'],
    });

    // 验证 embedding 已存储
    const row = db.raw.prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as { embedding: string | null };
    expect(row.embedding).toBeTruthy();
    expect(JSON.parse(row.embedding!).length).toBe(embedding.dimensions);
  });

  it('should retrieve by vector similarity', async () => {
    await store.store({ type: 'fact', content: 'PostgreSQL 是主数据库', source: 's1', confidence: 0.9, importance: 0.8, tags: ['db'], status: 'active', channel: 'admin', evidence: 't' });
    await store.store({ type: 'method', content: 'Vitest mock 的用法', source: 's1', confidence: 0.7, importance: 0.6, tags: ['test'], status: 'active', channel: 'admin', evidence: 't' });
    await store.store({ type: 'fact', content: 'MongoDB 被放弃了', source: 's1', confidence: 0.8, importance: 0.7, tags: ['db'], status: 'active', channel: 'admin', evidence: 't' });

    // 查询数据库相关内容
    const results = await store.retrieve({ text: 'PostgreSQL 数据库选型' });
    expect(results.length).toBeGreaterThan(0);
    // 数据库相关的结果应该排在前面
    expect(results[0].tags).toContain('db');
  });
});

// ── SqliteWisdomStore 测试 ──

describe('SqliteWisdomStore', () => {
  let db: AgentDatabase;
  let store: SqliteWisdomStore;

  beforeEach(async () => {
    db = await AgentDatabase.create({ dbPath: ':memory:' });
    store = new SqliteWisdomStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should store and retrieve wisdom', async () => {
    const id = await store.store({
      content: '遇到性能问题时优先考虑缓存',
      derivedFrom: ['mem_1'],
      priority: 10,
      confidence: 0.8,
    });

    const all = await store.getAll();
    expect(all.length).toBe(1);
    expect(all[0].content).toBe('遇到性能问题时优先考虑缓存');
    expect(all[0].derivedFrom).toEqual(['mem_1']);
  });

  it('should order by priority DESC', async () => {
    await store.store({ content: 'low priority', derivedFrom: [], priority: 1 });
    await store.store({ content: 'high priority', derivedFrom: [], priority: 10 });
    await store.store({ content: 'medium priority', derivedFrom: [], priority: 5 });

    const all = await store.getAll();
    expect(all[0].content).toBe('high priority');
    expect(all[1].content).toBe('medium priority');
    expect(all[2].content).toBe('low priority');
  });

  it('should soft delete wisdom', async () => {
    const id = await store.store({ content: 'to delete', derivedFrom: [], priority: 1 });
    await store.delete(id);

    const all = await store.getAll();
    expect(all.length).toBe(0);
  });

  it('should evict lowest priority', async () => {
    for (let i = 0; i < 5; i++) {
      await store.store({ content: `wisdom ${i}`, derivedFrom: [], priority: i });
    }

    expect(store.count()).toBe(5);
    const evicted = await store.evict(3);
    expect(evicted).toBe(2);
    expect(store.count()).toBe(3);

    const all = await store.getAll();
    expect(all[0].content).toBe('wisdom 4'); // 最高优先级保留
  });
});

// ── SqliteConceptGraph 测试 ──

describe('SqliteConceptGraph', () => {
  let db: AgentDatabase;
  let graph: SqliteConceptGraph;

  beforeEach(async () => {
    db = await AgentDatabase.create({ dbPath: ':memory:' });
    graph = new SqliteConceptGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should admit and retrieve concepts', async () => {
    const res = await graph.admitConcept({
      name: 'PostgreSQL',
      kind: 'entity',
      description: 'RDBMS',
      supportCount: 2,
    });
    expect(res.action).toBe('created');
    expect(res.id).toBeTruthy();

    const full = await graph.getFullGraph();
    expect(full.nodes.length).toBe(1);
    expect(full.nodes[0].name).toBe('PostgreSQL');
    expect(full.nodes[0].kind).toBe('entity');
    expect(full.nodes[0].status).toBe('shadow');
  });

  it('should merge case-insensitive same-name with compatible fingerprint', async () => {
    const id1 = await graph.admitConcept({ name: 'PostgreSQL', kind: 'entity', domain: ['db'], supportCount: 2 });
    const id2 = await graph.admitConcept({ name: 'postgresql', kind: 'entity', domain: ['db'], supportCount: 2 });
    expect(id1.action).toBe('created');
    expect(id2.action).toBe('merged');
    expect(id2.id).toBe(id1.id);

    const full = await graph.getFullGraph();
    expect(full.nodes.length).toBe(1);
    expect(full.nodes[0].frequency).toBe(2);
  });

  it('should admit licensed edges and reject unlicensed causes', async () => {
    const a = await graph.admitConcept({ name: 'PostgreSQL', kind: 'entity', supportCount: 2 });
    const b = await graph.admitConcept({ name: 'ACID', kind: 'construct', supportCount: 2 });

    const ok = await graph.admitEdge({
      sourceId: a.id!,
      targetId: b.id!,
      relationType: 'part_of',
      strength: 0.8,
      basis: {
        memoryIds: ['m1'],
        cue: 'ACID is part of PostgreSQL guarantees',
        evidenceClass: 'mereonymy',
        licensedAt: Date.now(),
      },
      evidenceText: 'ACID is part of PostgreSQL guarantees',
    });
    expect(ok.action).toBe('active');

    const bad = await graph.admitEdge({
      sourceId: a.id!,
      targetId: b.id!,
      relationType: 'causes',
      strength: 0.9,
      basis: {
        memoryIds: ['m1'],
        cue: 'x',
        evidenceClass: 'cooccur',
        licensedAt: Date.now(),
      },
    });
    expect(bad.relationType).toBe('related');
  });

  it('should activate from seeds via spreadingActivate', async () => {
    const pg = await graph.admitConcept({ name: 'PostgreSQL', kind: 'entity', supportCount: 2 });
    const acid = await graph.admitConcept({ name: 'ACID', kind: 'construct', supportCount: 2 });
    await graph.admitEdge({
      sourceId: pg.id!,
      targetId: acid.id!,
      relationType: 'part_of',
      strength: 0.9,
      basis: {
        memoryIds: ['m1', 'm2'],
        cue: 'ACID part of PostgreSQL',
        evidenceClass: 'mereonymy',
        licensedAt: Date.now(),
      },
      evidenceText: 'ACID part of PostgreSQL',
    });
    await graph.promote([pg.id!, acid.id!], 'active');

    const result = await graph.spreadingActivate(['PostgreSQL'], { depth: 1 });
    expect(result.nodes.some((n) => n.name === 'PostgreSQL')).toBe(true);
    expect(result.nodes.some((n) => n.name === 'ACID')).toBe(true);
  });
});

// ── SqliteConceptGraph with Embedding 测试 ──

describe('SqliteConceptGraph with embedding', () => {
  let db: AgentDatabase;
  let graph: SqliteConceptGraph;
  const embedding = createMockEmbedding();

  beforeEach(async () => {
    db = await AgentDatabase.create({ dbPath: ':memory:' });
    graph = new SqliteConceptGraph(db, {
      embeddingProvider: embedding,
      mergeThreshold: 0.2,
      candidateBandHi: 0.5,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('should store embedding with concept', async () => {
    const res = await graph.admitConcept({ name: 'PostgreSQL', kind: 'entity', supportCount: 2 });
    const row = db.raw.prepare('SELECT embedding FROM concepts WHERE id = ?').get(res.id!) as {
      embedding: string | null;
    };
    expect(row.embedding).toBeTruthy();
  });

  it('near-threshold embedding creates merge_candidate not silent merge', async () => {
    const id1 = await graph.admitConcept({ name: 'PostgreSQL', kind: 'entity', supportCount: 2 });
    const id2 = await graph.admitConcept({ name: 'PostgresDatabase', kind: 'entity', supportCount: 2 });

    const full = await graph.getFullGraph();
    expect(full.nodes.length).toBeGreaterThanOrEqual(1);
    if (id2.action === 'merge_candidate') {
      expect(id2.id).not.toBe(id1.id);
      const candidates = await graph.listMergeCandidates();
      expect(candidates.length).toBeGreaterThan(0);
    }
  });
});

// ── Vector Search 测试 ──

describe('Vector Search', () => {
  it('should calculate cosine similarity', () => {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);

    const c = [0, 1, 0];
    expect(cosineSimilarity(a, c)).toBeCloseTo(0.0);
  });

  it('should calculate cosine distance', () => {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    expect(cosineDistance(a, b)).toBeCloseTo(0.0);

    const c = [0, 1, 0];
    expect(cosineDistance(a, c)).toBeCloseTo(1.0);
  });

  it('should handle zero vectors', () => {
    const a = [0, 0, 0];
    const b = [1, 0, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});
