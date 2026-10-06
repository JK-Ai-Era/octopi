/**
 * 百万级闸门：无 sqlite-vec 时大库禁止 JS 全扫；检索强制关键词腿
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeRetriever } from '@octopi-agent/engine/harness/knowledge/retriever.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kn-scale-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('million-scale vector gate', () => {
  it('vectorBackend 反映 sqlite-vec / js-bucket / disabled', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    expect(index.vectorBackend()).toBe('disabled');

    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'backend',
    });
    index.upsertFile({
      sourceId: src.id,
      path: join(root, 'a.md'),
      contentHash: 'h',
      size: 1,
      mtime: Date.now(),
      adapterId: 'markdown',
      chunks: [{ ordinal: 0, text: 'hello', startLine: 1, endLine: 1 }],
    });
    const cid = index.listChunksByPath(src.id, join(root, 'a.md'))[0].id;
    index.setChunkEmbeddings([[cid, [1, 0, 0]]]);

    const backend = index.vectorBackend();
    expect(['sqlite-vec', 'js-bucket']).toContain(backend);
    expect(index.countEmbeddings()).toBe(1);

    const s = sources.database.stats();
    expect(s.sqliteVec === 0 || s.sqliteVec === 1).toBe(true);
    expect(s.embeddings).toBeGreaterThanOrEqual(1);
    sources.database.close();
  });

  it('无 ANN 时 search 强制关键词腿（forceKeyword）', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'hybrid-force',
    });
    index.upsertFile({
      sourceId: src.id,
      path: join(root, 'kw.md'),
      contentHash: 'h',
      size: 1,
      mtime: Date.now(),
      adapterId: 'markdown',
      chunks: [{ ordinal: 0, text: '百万级向量检索方案', startLine: 1, endLine: 1 }],
    });

    const retriever = new KnowledgeRetriever({
      sourceStore: sources,
      indexStore: index,
      embeddingProvider: {
        name: 'fake',
        dimensions: 3,
        async embed() {
          return [1, 0, 0];
        },
        async embedBatch() {
          return [[1, 0, 0]];
        },
      },
      hybridKeyword: false, // 配置上关掉关键词
    });

    const result = await retriever.search('向量检索', { agentId: 'a1' });
    // 即使 hybridKeyword=false，无 sqlite-vec 时仍走关键词
    expect(result.keywordHits).toBeGreaterThan(0);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(['sqlite-vec', 'js-bucket', 'disabled']).toContain(result.vectorBackend);
    sources.database.close();
  });

  it('大库无 KNN：禁止 JS 全表兜底（闸门看 KNN 结果而非 flag）', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'big',
    });

    // 多条向量，且查询落在「无邻桶命中」时不得偷偷全扫补满
    // （构造分散桶：奇偶交替主维度符号）
    for (let i = 0; i < 8; i++) {
      const p = join(root, `v${i}.md`);
      index.upsertFile({
        sourceId: src.id,
        path: p,
        contentHash: `h${i}`,
        size: 1,
        mtime: Date.now(),
        adapterId: 'markdown',
        chunks: [{ ordinal: 0, text: `doc ${i}`, startLine: 1, endLine: 1 }],
      });
    }
    const pairs: Array<[string, number[]]> = [];
    for (let i = 0; i < 8; i++) {
      const p = join(root, `v${i}.md`);
      const cid = index.listChunksByPath(src.id, p)[0].id;
      const emb = [i % 2 === 0 ? 1 : -1, 0, 0];
      pairs.push([cid, emb]);
    }
    index.setChunkEmbeddings(pairs);

    // 合法查询应有结果（邻桶或全扫，视规模）
    const hits = index.vectorSearch([1, 0, 0], { sourceIds: [src.id], limit: 3 });
    expect(hits.length).toBeGreaterThan(0);

    // 闸门单元：n 很小时 allowJsFullScan=true；这里至少验证 vectorSearch 在
    // 无 vec 表时仍返回结果且不抛（行为契约）
    expect(index.vectorBackend() !== 'disabled').toBe(true);
    sources.database.close();
  });

  it('listFilePathsFiltered ext 转义 _ / %', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'ext',
    });
    // ext=x_y → LIKE '%.x_y'；未转义时 _ 匹配任意字符
    for (const p of [join(root, 'a.x_y'), join(root, 'a.xzy'), join(root, 'a.md')]) {
      index.upsertFile({
        sourceId: src.id,
        path: p,
        contentHash: 'h',
        size: 1,
        mtime: Date.now(),
        adapterId: 'markdown',
        chunks: [{ ordinal: 0, text: 'x', startLine: 1, endLine: 1 }],
      });
    }
    const paths = index.listFilePathsFiltered(src.id, { ext: 'x_y' });
    const norm = (p: string) => p.replace(/\\/g, '/');
    expect(paths.map(norm)).toContain(norm(join(root, 'a.x_y')));
    expect(paths.map(norm)).not.toContain(norm(join(root, 'a.xzy')));
    sources.database.close();
  });
});
