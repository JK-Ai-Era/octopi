/**
 * Cognition 召回种子 — 切词 / 双向匹配 / 双 store spreadingActivate 同构回归
 *
 * 回归用例取自 2026-11-18 召回诊断的三条真实查询（R2）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AgentDatabase,
  InMemoryConceptGraph,
  SqliteConceptGraph,
  deriveQuerySeeds,
  createSeedMatcher,
} from '@octopi-agent/engine/harness/memory/index.js';
import { CognitionLayer } from '@octopi-agent/engine/harness/context/index.js';
import { probeContextLayerHealth } from '@octopi-agent/engine/harness/context/layer-health.js';
import type { ConceptGraphStore } from '@octopi-agent/engine/harness/memory/types.js';
import type { EmbeddingProvider } from '@octopi-agent/engine/harness/memory/sqlite/embedding.js';

describe('deriveQuerySeeds', () => {
  it('按空白与标点切词，token ≥2 字', () => {
    expect(deriveQuerySeeds('进程模块缓存 这些概念是保存在哪里的？')).toEqual([
      '进程模块缓存',
      '这些概念是保存在哪里的',
    ]);
  });

  it('无空格无标点整句保留为单 token（反向匹配的锚点）', () => {
    expect(deriveQuerySeeds('你给我详细讲一下现在概念提取的逻辑和时机')).toEqual([
      '你给我详细讲一下现在概念提取的逻辑和时机',
    ]);
  });

  it('全短 token 时回退整句', () => {
    expect(deriveQuerySeeds('哦？')).toEqual(['哦？']);
    expect(deriveQuerySeeds('   ')).toEqual([]);
  });

  it('子句超上限截断并补整句兜底（反向覆盖面不因截断丢失）', () => {
    const numerals = '甲乙丙丁戊己庚辛壬癸';
    const clauses = Array.from({ length: 9 }, (_, i) => `${numerals[i]}段讲的事情`);
    const q = clauses.join('，');
    const seeds = deriveQuerySeeds(q);
    expect(seeds).toHaveLength(9); // 8 子句 + 整句兜底
    expect(seeds.slice(0, 8)).toEqual(clauses.slice(0, 8));
    expect(seeds[seeds.length - 1]).toBe(q);
    expect(new Set(seeds).size).toBe(seeds.length); // 无重复污染
  });

  it('恰在上限内不补整句兜底', () => {
    const numerals = '甲乙丙丁戊己庚辛壬癸';
    const clauses = Array.from({ length: 8 }, (_, i) => `${numerals[i]}段讲的事情`);
    expect(deriveQuerySeeds(clauses.join('，'))).toEqual(clauses);
  });

  it('CJK 滑窗二元组不入种子（防误锚）', () => {
    expect(deriveQuerySeeds('上下文切片')).toEqual(['上下文切片']);
  });
});

describe('createSeedMatcher', () => {
  it('正向：name / description 含 token 命中', () => {
    const m = createSeedMatcher(['版本重放验证']);
    expect(m('版本重放验证', null)).toBe(true);
    expect(m('ReplayCheck', '做版本重放验证的工具')).toBe(true);
  });

  it('反向：token 含 name 命中（无空格直呼概念名）', () => {
    const m = createSeedMatcher(['进程模块缓存是保存在哪里的']);
    expect(m('进程模块缓存', null)).toBe(true);
  });

  it('反向不参与单字 name（防误锚），正向不受影响', () => {
    expect(createSeedMatcher(['锁定了吗'])('锁', null)).toBe(false);
    expect(createSeedMatcher(['锁'])('锁', null)).toBe(true);
  });

  it('单字种子仅精确命中（防子串误锚）', () => {
    expect(createSeedMatcher(['a'])('bar', null)).toBe(false);
    expect(createSeedMatcher(['a'])('a', null)).toBe(true);
    expect(createSeedMatcher(['锁'])('锁机制', null)).toBe(false);
    expect(createSeedMatcher(['锁'])('锁', null)).toBe(true);
  });

  it('大小写与首尾空白归一后匹配', () => {
    expect(createSeedMatcher([' ContextLayer '])('contextlayer', null)).toBe(true);
  });

  it('空种子不命中', () => {
    expect(createSeedMatcher([''])('进程模块缓存', '描述')).toBe(false);
    expect(createSeedMatcher([])('进程模块缓存', null)).toBe(false);
  });
});

describe('CognitionLayer 种子推导接线', () => {
  it('走共享切词：标点子句种子 + 描述匹配（钉住 layers.ts，回退旧空白切词会失败）', async () => {
    const store = new InMemoryConceptGraph();
    const a = await store.admitConcept({
      name: 'ReplayCheck',
      kind: 'entity',
      description: '做版本重放验证的工具',
      supportCount: 2,
    });
    await store.promote([a.id!], 'active');

    const layer = new CognitionLayer({ store });
    const result = await layer.assemble({
      sessionId: 's',
      messages: [],
      query: '版本重放验证，与上下文切片锚定有什么关系',
      tokenBudget: 800,
      systemBudget: 800,
    });

    // 旧空白切词＝整句 1 种子（description 不含整句 → 0 命中 → null）；
    // 新切词产出「版本重放验证」子句种子 → description 命中
    expect(result?.text).toContain('ReplayCheck');
  });
});

describe.each([
  ['InMemoryConceptGraph', () => new InMemoryConceptGraph()],
  [
    'SqliteConceptGraph',
    () => {
      // holder set in beforeEach
      return null as unknown as ConceptGraphStore;
    },
  ],
] as const)('%s spreadingActivate 种子回归（真实查询）', (label, factory) => {
  let store: ConceptGraphStore;
  let db: AgentDatabase | null = null;

  beforeEach(async () => {
    if (label === 'SqliteConceptGraph') {
      db = await AgentDatabase.create({ dbPath: ':memory:' });
      store = new SqliteConceptGraph(db);
    } else {
      store = factory();
    }
    for (const name of ['进程模块缓存', '上下文切片锚定', '版本重放验证']) {
      const r = await store.admitConcept({ name, kind: 'construct', supportCount: 2 });
      await store.promote([r.id!], 'active');
    }
  });

  afterEach(() => {
    db?.close();
  });

  it('无空格直呼概念名必须命中（R2 验收）', async () => {
    const g = await store.spreadingActivate(deriveQuerySeeds('进程模块缓存是保存在哪里的？'));
    expect(g.nodes.map((n) => n.name)).toContain('进程模块缓存');
  });

  it('有空格查询回归不倒退', async () => {
    const g = await store.spreadingActivate(deriveQuerySeeds('进程模块缓存 这些概念是保存在哪里的？'));
    expect(g.nodes.map((n) => n.name)).toContain('进程模块缓存');
  });

  it('整句含多个直呼名全部命中', async () => {
    const g = await store.spreadingActivate(
      deriveQuerySeeds('版本重放验证和上下文切片锚定有什么关系'),
    );
    const names = g.nodes.map((n) => n.name);
    expect(names).toContain('版本重放验证');
    expect(names).toContain('上下文切片锚定');
  });

  it('截断后整句兜底：第 9 子句直呼的概念仍命中', async () => {
    const numerals = '甲乙丙丁戊己庚辛壬癸';
    const clauses = Array.from({ length: 8 }, (_, i) => `${numerals[i]}段讲的事情`);
    const q = [...clauses, '最后想问版本重放验证的流程'].join('，');
    const g = await store.spreadingActivate(deriveQuerySeeds(q));
    expect(g.nodes.map((n) => n.name)).toContain('版本重放验证');
  });

  it('语义近指当前无词面命中（D 范围，锁定边界防回退）', async () => {
    const spaced = await store.spreadingActivate(
      deriveQuerySeeds('检查一下 认知概念的召回逻辑 确保'),
    );
    const compact = await store.spreadingActivate(
      deriveQuerySeeds('你给我详细讲一下现在概念提取的逻辑和时机'),
    );
    expect(spaced.nodes).toHaveLength(0);
    expect(compact.nodes).toHaveLength(0);
  });
});

// ── 语义种子（D）：查询向量近邻取概念名作种子 ──

function fixedProvider(table: Record<string, number[]>): EmbeddingProvider {
  const embed = async (t: string): Promise<number[]> => {
    const v = table[t];
    if (!v) throw new Error(`no fixed vector for ${t}`);
    return v;
  };
  return {
    name: 'fixed',
    dimensions: 2,
    embed,
    embedBatch: async (texts: string[]) => Promise.all(texts.map(embed)),
  };
}

describe('semanticSeeds', () => {
  it('向量近邻取名、近者优先、band 外不取、k 封顶', async () => {
    const db = await AgentDatabase.create({ dbPath: ':memory:' });
    const graph = new SqliteConceptGraph(db, {
      embeddingProvider: fixedProvider({
        查询: [1, 0],
        甲概念: [5, 1], // 距离 ≈ 0.02
        乙概念: [1, 1], // 距离 ≈ 0.29（默认 band 上界 0.35 内）
        丙概念: [0, 1], // 距离 1.0，band 外
      }),
    });
    for (const name of ['甲概念', '乙概念', '丙概念']) {
      await graph.admitConcept({ name, kind: 'construct', supportCount: 2 });
    }
    expect(graph.supportsSemanticSeeds).toBe(true);
    expect(await graph.semanticSeeds('查询')).toEqual(['甲概念', '乙概念']);
    expect(await graph.semanticSeeds('查询', 1)).toEqual(['甲概念']);
    db.close();
  });

  it('无 provider / 嵌入失败 / 空查询 → 空数组不 fail（增强路径降级）', async () => {
    const bare = new InMemoryConceptGraph();
    expect(bare.supportsSemanticSeeds).toBe(false);
    expect(await bare.semanticSeeds('任何查询')).toEqual([]);

    const db = await AgentDatabase.create({ dbPath: ':memory:' });
    const broken = new SqliteConceptGraph(db, {
      embeddingProvider: fixedProvider({}),
    });
    expect(await broken.semanticSeeds('查无向量')).toEqual([]); // embed 抛错 → 降级空
    expect(await broken.semanticSeeds('  ')).toEqual([]);
    db.close();
  });

  it('维度失配行跳过不炸（provider 换代遗留向量）', async () => {
    const db = await AgentDatabase.create({ dbPath: ':memory:' });
    const graph = new SqliteConceptGraph(db, {
      embeddingProvider: fixedProvider({ 查询: [1, 0], 甲概念: [5, 1] }),
    });
    await graph.admitConcept({ name: '甲概念', kind: 'construct', supportCount: 2 });
    db.raw
      .prepare(
        "INSERT INTO concepts (id, name, kind, memory_ids, domain, frequency, status, embedding, created_at, updated_at) VALUES ('cpt_odd', '异维概念', 'construct', '[]', '[]', 1, 'active', '[1,2,3]', 1, 1)",
      )
      .run();
    expect(await graph.semanticSeeds('查询')).toEqual(['甲概念']);
    db.close();
  });
});

describe('CognitionLayer 语义种子接入（D 验收形态）', () => {
  const provider = fixedProvider({
    // 词面种子打不中概念名，但语义近邻能召回——「认知概念的召回逻辑」→「上下文切片锚定」同款
    认知概念的召回逻辑: [1, 0],
    上下文切片锚定: [5, 1], // 距离 ≈ 0.02
  });

  it('词面无命中时语义种子补召回；无向量能力时降级纯词面不炸', async () => {
    const db = await AgentDatabase.create({ dbPath: ':memory:' });
    const graph = new SqliteConceptGraph(db, { embeddingProvider: provider });
    const a = await graph.admitConcept({ name: '上下文切片锚定', kind: 'construct', supportCount: 2 });
    await graph.promote([a.id!], 'active');

    // R4 暂关后语义种子为显式 opt-in：D 验收形态显式开启
    const layer = new CognitionLayer({ store: graph, semanticSeedCount: 4 });
    const result = await layer.assemble({
      sessionId: 's',
      messages: [],
      query: '认知概念的召回逻辑',
      tokenBudget: 800,
      systemBudget: 800,
    });
    // 词面种子「认知概念的召回逻辑」打不中「上下文切片锚定」；语义种子把概念名送进扩散激活
    expect(result?.text).toContain('上下文切片锚定');

    // R4 暂关（默认 semanticSeedCount=0）：不显式开启则语义种子不参与召回
    const optedOff = await new CognitionLayer({ store: graph }).assemble({
      sessionId: 's',
      messages: [],
      query: '认知概念的召回逻辑',
      tokenBudget: 800,
      systemBudget: 800,
    });
    expect(optedOff).toBeNull();

    // 降级：InMemory 无向量 → 纯词面（0 命中返 null，不抛）
    const bare = new InMemoryConceptGraph();
    await bare.admitConcept({ name: '上下文切片锚定', kind: 'construct', supportCount: 2 });
    const degraded = await new CognitionLayer({ store: bare }).assemble({
      sessionId: 's',
      messages: [],
      query: '认知概念的召回逻辑',
      tokenBudget: 800,
      systemBudget: 800,
    });
    expect(degraded).toBeNull();
    db.close();
  });

  it('layer-health 降级注记只按装配事实（未知不冒充能力判定——home 探针误报回归锚）', async () => {
    const bare = new InMemoryConceptGraph();
    const known = await probeContextLayerHealth({
      agentId: 'a',
      cognitionStore: bare,
      semanticSeedsCapable: false,
    });
    expect(known.layers.find((l) => l.id === 'cognition')?.degraded).toEqual([
      'semantic_seeds_unavailable',
    ]);
    // 调用方未给装配事实（home 探针路径）→ 不注记
    const unknown = await probeContextLayerHealth({ agentId: 'a', cognitionStore: bare });
    expect(unknown.layers.find((l) => l.id === 'cognition')?.degraded).toBeUndefined();
  });

  it('距离带区分：0.445 在语义带（0.65）内、同一性带（0.35）外；旋钮可收紧', async () => {
    const db = await AgentDatabase.create({ dbPath: ':memory:' });
    const graph = new SqliteConceptGraph(db, {
      embeddingProvider: fixedProvider({ 查询: [1, 0], 丁概念: [1, 1.5] }), // 距离 ≈ 0.445
    });
    await graph.admitConcept({ name: '丁概念', kind: 'construct', supportCount: 2 });
    expect(await graph.semanticSeeds('查询')).toEqual(['丁概念']); // 0.65 带内（0.35 带会漏）
    const tight = new SqliteConceptGraph(db, {
      embeddingProvider: fixedProvider({ 查询: [1, 0], 丁概念: [1, 1.5] }),
      semanticSeedMaxDistance: 0.4,
    });
    expect(await tight.semanticSeeds('查询')).toEqual([]); // 收紧到 0.4 即漏
    db.close();
  });

  it('嵌入超时降级空种子（热路径防无界延迟）', async () => {
    const db = await AgentDatabase.create({ dbPath: ':memory:' });
    const hang: EmbeddingProvider = {
      name: 'hang',
      dimensions: 2,
      embed: () => new Promise<number[]>(() => {}), // 永不返回
      embedBatch: () => new Promise<number[][]>(() => {}),
    };
    const graph = new SqliteConceptGraph(db, {
      embeddingProvider: hang,
      semanticSeedEmbedTimeoutMs: 50,
    });
    const started = Date.now();
    expect(await graph.semanticSeeds('查询')).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
    db.close();
  });

  it('semanticSeedCount: 0 关闭语义种子（负对照）', async () => {
    const db = await AgentDatabase.create({ dbPath: ':memory:' });
    const graph = new SqliteConceptGraph(db, {
      embeddingProvider: fixedProvider({ 认知概念的召回逻辑: [1, 0], 上下文切片锚定: [5, 1] }),
    });
    const a = await graph.admitConcept({ name: '上下文切片锚定', kind: 'construct', supportCount: 2 });
    await graph.promote([a.id!], 'active');
    const off = await new CognitionLayer({ store: graph, semanticSeedCount: 0 }).assemble({
      sessionId: 's',
      messages: [],
      query: '认知概念的召回逻辑',
      tokenBudget: 800,
      systemBudget: 800,
    });
    expect(off).toBeNull(); // 语义关 → 纯词面 0 命中
    db.close();
  });
});
