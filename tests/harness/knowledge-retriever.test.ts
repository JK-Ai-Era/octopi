/**
 * Knowledge P3 — embedding Phase B + hybrid 检索 + auto-ground 降级
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSourceStore } from '../../src/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '../../src/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '../../src/harness/knowledge/ingest.js';
import { KnowledgeRetriever } from '../../src/harness/knowledge/retriever.js';
import type { EmbeddingProvider } from '../../src/harness/memory/sqlite/embedding.js';

/** 确定性假向量：按词哈希到维度桶 */
function fakeEmbedding(dim = 8): EmbeddingProvider {
  const embedOne = (text: string): number[] => {
    const v = Array.from({ length: dim }, () => 0);
    for (const tok of text.toLowerCase().split(/\s+/).filter(Boolean)) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      v[h % dim] += 1;
    }
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
  };
  return {
    name: 'fake',
    dimensions: dim,
    async embed(text: string) {
      return embedOne(text);
    },
    async embedBatch(texts: string[]) {
      return texts.map(embedOne);
    },
  };
}

async function setup(opts?: { embedding?: EmbeddingProvider | null }) {
  const root = await mkdtemp(join(tmpdir(), 'octopi-kn3-'));
  const store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
  const embedding = opts?.embedding ?? null;
  const ingest = new KnowledgeIngest({
    sourceStore: store,
    embeddingProvider: embedding,
    embedMinIntervalMs: 0,
  });
  return {
    root,
    store,
    ingest,
    embedding,
    cleanup: async () => {
      ingest.dispose();
      store.database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('Phase B embedding', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it('有 provider 时写入 chunk 向量并参与 vectorSearch', async () => {
    ctx = await setup({ embedding: fakeEmbedding() });
    const dir = join(ctx.root, 'docs');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.md'), '# alpha\n\nunique zebra token here\n', 'utf8');

    const src = ctx.store.register({
      kind: 'directory',
      location: dir,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'docs',
    });
    await ctx.ingest.ingestSource(src.id);
    await ctx.ingest.idle();

    const embCov = ctx.ingest.indexStore.embeddingCoverage(src.id);
    expect(embCov).toBe(1);

    const q = await ctx.embedding!.embed('unique zebra token');
    const vHits = ctx.ingest.indexStore.vectorSearch(q, { sourceIds: [src.id] });
    expect(vHits.length).toBeGreaterThan(0);
  });

  it('无 provider 时纯关键词仍可用，embeddingCoverage 无向量', async () => {
    ctx = await setup({ embedding: null });
    const dir = join(ctx.root, 'k');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.md'), '# t\n\nkeyword only body\n', 'utf8');

    const src = ctx.store.register({
      kind: 'directory',
      location: dir,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'k',
    });
    await ctx.ingest.ingestSource(src.id);
    await ctx.ingest.idle();

    const hits = ctx.ingest.indexStore.search('keyword only', { sourceIds: [src.id] });
    expect(hits.length).toBeGreaterThan(0);
    expect(ctx.ingest.indexStore.embeddingCoverage(src.id)).toBe(0);
  });
});

describe('KnowledgeRetriever hybrid + autoGround', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it('hybrid 融合 keyword+vector', async () => {
    const emb = fakeEmbedding();
    ctx = await setup({ embedding: emb });
    const dir = join(ctx.root, 'h');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'x.md'), '# x\n\ncompliance policy document about retention\n', 'utf8');
    await writeFile(join(dir, 'y.md'), '# y\n\nunrelated gardening tips\n', 'utf8');

    const src = ctx.store.register({
      kind: 'directory',
      location: dir,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'h',
    });
    await ctx.ingest.ingestSource(src.id);
    await ctx.ingest.idle();

    const retriever = new KnowledgeRetriever({
      sourceStore: ctx.store,
      indexStore: ctx.ingest.indexStore,
      embeddingProvider: emb,
      injectMinScore: 0.2,
      hintMinScore: 0.05,
    });

    const result = await retriever.search('compliance retention policy', {
      agentId: 'a1',
    });
    expect(result.usedVector).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].text).toContain('retention');
  });

  it('autoGround：高分 inject / 低 coverage 抬地板 / 无命中 none', async () => {
    const emb = fakeEmbedding();
    ctx = await setup({ embedding: emb });
    const dir = join(ctx.root, 'g');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.md'), '# a\n\nspecific topic alpha beta gamma\n', 'utf8');

    const src = ctx.store.register({
      kind: 'directory',
      location: dir,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'g',
    });
    await ctx.ingest.ingestSource(src.id);
    await ctx.ingest.idle();

    const retriever = new KnowledgeRetriever({
      sourceStore: ctx.store,
      indexStore: ctx.ingest.indexStore,
      embeddingProvider: emb,
      injectMinScore: 0.15,
      hintMinScore: 0.05,
      minCoverage: 0.99,
      maxChunks: 2,
    });

    const decision = await retriever.autoGround('topic alpha beta', { agentId: 'a1' });
    expect(['inject', 'hint', 'none']).toContain(decision.mode);
    expect(decision.coverage).toBeGreaterThan(0);

    // 默认门槛下，无关查询不应 inject
    const strict = new KnowledgeRetriever({
      sourceStore: ctx.store,
      indexStore: ctx.ingest.indexStore,
      embeddingProvider: emb,
      minCoverage: 0,
    });
    const empty = await strict.autoGround('quantum banana unrelated', { agentId: 'a1' });
    expect(empty.hits.length).toBe(0);
    if (empty.mode === 'inject') {
      throw new Error('unrelated query must not inject');
    }
  });

  it('默认门槛 + 有 embedding 时 keyword 可达 inject', async () => {
    const emb = fakeEmbedding();
    ctx = await setup({ embedding: emb });
    const dir = join(ctx.root, 'floor');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'f.md'), '# f\n\nuniquezzz keyword only content here\n', 'utf8');
    const src = ctx.store.register({
      kind: 'directory',
      location: dir,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'floor',
    });
    await ctx.ingest.ingestSource(src.id);
    await ctx.ingest.idle();

    // 不压低 injectMinScore（默认 0.78）
    const retriever = new KnowledgeRetriever({
      sourceStore: ctx.store,
      indexStore: ctx.ingest.indexStore,
      embeddingProvider: emb,
      minCoverage: 0,
    });
    const result = await retriever.search('uniquezzz keyword only', { agentId: 'a1' });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].score).toBeGreaterThanOrEqual(0.78);
  });

  it('可见性过滤进检索', async () => {
    ctx = await setup({ embedding: null });
    const dir = join(ctx.root, 'v');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'p.md'), '# p\n\nproject secret docs\n', 'utf8');

    const src = ctx.store.register({
      kind: 'directory',
      location: dir,
      scopeRef: { level: 'project', key: 'proj-x' },
      displayName: 'v',
    });
    await ctx.ingest.ingestSource(src.id);
    await ctx.ingest.idle();

    const retriever = new KnowledgeRetriever({
      sourceStore: ctx.store,
      indexStore: ctx.ingest.indexStore,
    });
    const hidden = await retriever.search('project secret', { agentId: 'a1' });
    expect(hidden.hits.length).toBe(0);

    ctx.store.assignProject('proj-x', 'a1');
    const shown = await retriever.search('project secret', { agentId: 'a1' });
    expect(shown.hits.length).toBeGreaterThan(0);
  });
});
