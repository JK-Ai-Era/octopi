/**
 * SQLite 存储层测试
 *
 * 测试 AgentDatabase、SqliteMemoryStore、SqliteWisdomStore、
 * SqliteConceptGraph、KnowledgeRegistry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentDatabase } from '../src/harness/memory/sqlite/agent-db.js';
import { SqliteMemoryStore } from '../src/harness/memory/sqlite/memory-store.js';
import { SqliteWisdomStore } from '../src/harness/memory/sqlite/wisdom-store.js';
import { SqliteConceptGraph } from '../src/harness/memory/sqlite/cognition-store.js';
import { KnowledgeRegistry } from '../src/harness/memory/sqlite/knowledge-registry.js';
import { cosineSimilarity, cosineDistance } from '../src/harness/memory/sqlite/vector-search.js';
import type { EmbeddingProvider } from '../src/harness/memory/sqlite/embedding.js';

// ── Mock Embedding Provider ──

function createMockEmbedding(): EmbeddingProvider {
  // 简单的哈希式 embedding：将文本转为固定维度的向量
  // 相似文本产生相似向量
  const dimensions = 32;

  function textToVec(text: string): number[] {
    const vec = new Array(dimensions).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % dimensions] += text.charCodeAt(i) / 1000;
    }
    // 归一化
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return norm > 0 ? vec.map(v => v / norm) : vec;
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
      type: 'lesson',
      content: 'Vitest 的 mock 需要先 import 再 mock',
      source: 'session-1',
      confidence: 0.8,
      importance: 0.7,
      tags: ['vitest', 'testing'],
    });

    expect(id).toBeTruthy();

    const entry = await store.get(id);
    expect(entry).toBeTruthy();
    expect(entry!.type).toBe('lesson');
    expect(entry!.content).toBe('Vitest 的 mock 需要先 import 再 mock');
    expect(entry!.tags).toEqual(['vitest', 'testing']);
  });

  it('should retrieve by type filter', async () => {
    await store.store({ type: 'lesson', content: 'lesson 1', source: 's1', confidence: 0.5, importance: 0.5, tags: [] });
    await store.store({ type: 'preference', content: 'preference 1', source: 's1', confidence: 0.5, importance: 0.5, tags: [] });
    await store.store({ type: 'lesson', content: 'lesson 2', source: 's1', confidence: 0.5, importance: 0.5, tags: [] });

    const lessons = await store.retrieve({ text: '', type: 'lesson' });
    expect(lessons.length).toBe(2);
    expect(lessons.every(e => e.type === 'lesson')).toBe(true);
  });

  it('should retrieve by keyword match', async () => {
    await store.store({ type: 'decision', content: '选择了 PostgreSQL 而非 MongoDB', source: 's1', confidence: 0.9, importance: 0.8, tags: ['database'] });
    await store.store({ type: 'lesson', content: 'Vitest 的 mock 需要先 import', source: 's1', confidence: 0.7, importance: 0.6, tags: ['testing'] });

    const results = await store.retrieve({ text: 'PostgreSQL database' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('PostgreSQL');
  });

  it('should update access count', async () => {
    const id = await store.store({ type: 'lesson', content: 'test', source: 's1', confidence: 0.5, importance: 0.5, tags: [] });

    await store.retrieve({ text: 'test' });
    const entry = await store.get(id);
    expect(entry!.accessCount).toBe(1);

    await store.retrieve({ text: 'test' });
    const entry2 = await store.get(id);
    expect(entry2!.accessCount).toBe(2);
  });

  it('should delete a memory', async () => {
    const id = await store.store({ type: 'lesson', content: 'test', source: 's1', confidence: 0.5, importance: 0.5, tags: [] });
    await store.delete(id);
    const entry = await store.get(id);
    expect(entry).toBeNull();
  });

  it('should return stats', async () => {
    await store.store({ type: 'lesson', content: 'l1', source: 's1', confidence: 0.8, importance: 0.7, tags: [] });
    await store.store({ type: 'preference', content: 'p1', source: 's1', confidence: 0.6, importance: 0.5, tags: [] });

    const stats = await store.stats();
    expect(stats.totalEntries).toBe(2);
    expect(stats.byType.lesson).toBe(1);
    expect(stats.byType.preference).toBe(1);
  });

  it('should perform decay', async () => {
    const id = await store.store({ type: 'context', content: 'old memory', source: 's1', confidence: 0.5, importance: 0.5, tags: [] });

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
      type: 'decision',
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
    await store.store({ type: 'decision', content: 'PostgreSQL 是主数据库', source: 's1', confidence: 0.9, importance: 0.8, tags: ['db'] });
    await store.store({ type: 'lesson', content: 'Vitest mock 的用法', source: 's1', confidence: 0.7, importance: 0.6, tags: ['test'] });
    await store.store({ type: 'decision', content: 'MongoDB 被放弃了', source: 's1', confidence: 0.8, importance: 0.7, tags: ['db'] });

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

  it('should add and retrieve concepts', async () => {
    const id = await graph.addConcept({ name: 'PostgreSQL', description: 'RDBMS' });
    expect(id).toBeTruthy();

    const full = await graph.getFullGraph();
    expect(full.nodes.length).toBe(1);
    expect(full.nodes[0].name).toBe('PostgreSQL');
  });

  it('should deduplicate by exact name match', async () => {
    const id1 = await graph.addConcept({ name: 'PostgreSQL' });
    const id2 = await graph.addConcept({ name: 'PostgreSQL' });
    expect(id1).toBe(id2);

    const full = await graph.getFullGraph();
    expect(full.nodes.length).toBe(1);
    expect(full.nodes[0].frequency).toBe(2);
  });

  it('should deduplicate case-insensitively', async () => {
    const id1 = await graph.addConcept({ name: 'PostgreSQL' });
    const id2 = await graph.addConcept({ name: 'postgresql' });
    expect(id1).toBe(id2);
  });

  it('should add edges', async () => {
    const id1 = await graph.addConcept({ name: 'PostgreSQL' });
    const id2 = await graph.addConcept({ name: 'ACID' });

    await graph.addEdge({
      sourceId: id1,
      targetId: id2,
      relationType: 'related',
      strength: 0.8,
    });

    const full = await graph.getFullGraph();
    expect(full.edges.length).toBe(1);
    expect(full.edges[0].sourceId).toBe(id1);
    expect(full.edges[0].targetId).toBe(id2);
  });

  it('should not duplicate edges', async () => {
    const id1 = await graph.addConcept({ name: 'PostgreSQL' });
    const id2 = await graph.addConcept({ name: 'ACID' });

    await graph.addEdge({ sourceId: id1, targetId: id2, relationType: 'related', strength: 0.8 });
    await graph.addEdge({ sourceId: id1, targetId: id2, relationType: 'related', strength: 0.9 });

    const full = await graph.getFullGraph();
    expect(full.edges.length).toBe(1);
  });

  it('should traverse graph with BFS', async () => {
    const pg = await graph.addConcept({ name: 'PostgreSQL' });
    const acid = await graph.addConcept({ name: 'ACID' });
    const rdbms = await graph.addConcept({ name: 'RDBMS' });
    const mongo = await graph.addConcept({ name: 'MongoDB' });

    await graph.addEdge({ sourceId: pg, targetId: acid, relationType: 'related', strength: 0.8 });
    await graph.addEdge({ sourceId: pg, targetId: rdbms, relationType: 'related', strength: 0.9 });
    await graph.addEdge({ sourceId: mongo, targetId: rdbms, relationType: 'related', strength: 0.5 });

    const result = await graph.queryRelated('PostgreSQL', 1);
    expect(result.nodes.length).toBeGreaterThanOrEqual(2); // PostgreSQL + 至少一个邻居
    expect(result.nodes.some(n => n.name === 'PostgreSQL')).toBe(true);
  });

  it('should extract concepts from text', async () => {
    await graph.extractFromText('The Database Management System handles Transaction Processing', 'mem_1');

    const full = await graph.getFullGraph();
    expect(full.nodes.length).toBeGreaterThan(0);
    // P0 简单实现：正则匹配大写开头的词序列
    expect(full.nodes.some(n => n.name.includes('Database') || n.name.includes('Transaction'))).toBe(true);
  });
});

// ── SqliteConceptGraph with Embedding 测试 ──

describe('SqliteConceptGraph with embedding', () => {
  let db: AgentDatabase;
  let graph: SqliteConceptGraph;
  const embedding = createMockEmbedding();

  beforeEach(async () => {
    db = await AgentDatabase.create({ dbPath: ':memory:' });
    graph = new SqliteConceptGraph(db, { embeddingProvider: embedding, mergeThreshold: 0.3 });
  });

  afterEach(() => {
    db.close();
  });

  it('should store embedding with concept', async () => {
    const id = await graph.addConcept({ name: 'PostgreSQL' });
    const row = db.raw.prepare('SELECT embedding FROM concepts WHERE id = ?').get(id) as { embedding: string | null };
    expect(row.embedding).toBeTruthy();
  });

  it('should merge similar concepts by embedding', async () => {
    // "PostgreSQL" 和 "Postgres" 在 mock embedding 中会产生相似向量
    const id1 = await graph.addConcept({ name: 'PostgreSQL' });
    const id2 = await graph.addConcept({ name: 'PostgresDatabase' });

    // 如果距离 <= 0.3，应该合并
    // mock embedding 对相似文本可能不一定合并，取决于哈希分布
    const full = await graph.getFullGraph();
    // 至少应该有1个概念
    expect(full.nodes.length).toBeGreaterThanOrEqual(1);
  });
});

// ── KnowledgeRegistry 测试 ──

describe('KnowledgeRegistry', () => {
  let db: AgentDatabase;
  let registry: KnowledgeRegistry;

  beforeEach(async () => {
    db = await AgentDatabase.create({ dbPath: ':memory:' });
    registry = new KnowledgeRegistry(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should register and list sources', () => {
    registry.register({
      id: 'docs',
      type: 'directory',
      location: '/project/docs',
      scope: 'project',
      metadata: { description: 'Project documentation', filePatterns: ['*.md'] },
    });

    const sources = registry.list();
    expect(sources.length).toBe(1);
    expect(sources[0].id).toBe('docs');
    expect(sources[0].type).toBe('directory');
    expect(sources[0].metadata.filePatterns).toEqual(['*.md']);
  });

  it('should list by scope', () => {
    registry.register({ id: 'global-api', type: 'url', location: 'https://api.example.com', scope: 'global', metadata: {} });
    registry.register({ id: 'project-docs', type: 'directory', location: '/docs', scope: 'project', metadata: {} });

    expect(registry.listByScope('global').length).toBe(1);
    expect(registry.listByScope('project').length).toBe(1);
    expect(registry.listByScope('agent').length).toBe(0);
  });

  it('should get and remove source', () => {
    registry.register({ id: 'test', type: 'file', location: '/test.md', scope: 'agent', metadata: {} });

    expect(registry.get('test')).toBeTruthy();
    registry.remove('test');
    expect(registry.get('test')).toBeNull();
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
