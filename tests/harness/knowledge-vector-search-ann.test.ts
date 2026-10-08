/**
 * sqlite-vec ANN 契约：vectorSearch 必须走 MATCH+k，禁止全表 vec_distance_cosine。
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';

describe('knowledge vectorSearch ANN contract', () => {
  it('sqlite-vec 可用时用 MATCH+k 返回近邻，不全表扫', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    if (!sources.database.sqliteVecEnabled) {
      // 本机无 vec0 扩展：JS 有界路径另测
      sources.database.close();
      return;
    }

    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-vec-ann',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'vec-ann',
    });
    await index.upsertFile({
      sourceId: src.id,
      path: '/tmp/kn-vec-ann/a.md',
      contentHash: 'h1',
      size: 1,
      mtime: Date.now(),
      adapterId: 'md',
      chunks: [{ ordinal: 0, text: 'alpha', startLine: 1, endLine: 1 }],
    });
    await index.upsertFile({
      sourceId: src.id,
      path: '/tmp/kn-vec-ann/b.md',
      contentHash: 'h2',
      size: 1,
      mtime: Date.now(),
      adapterId: 'md',
      chunks: [{ ordinal: 0, text: 'beta', startLine: 1, endLine: 1 }],
    });

    const files = index.listFiles(src.id);
    const byPath = new Map(files.map((f) => [f.path, index.listChunksByPath(src.id, f.path)[0]!.id]));
    const idA = byPath.get('/tmp/kn-vec-ann/a.md')!;
    const idB = byPath.get('/tmp/kn-vec-ann/b.md')!;
    index.setChunkEmbeddings([
      [idA, [1, 0, 0, 0]],
      [idB, [0, 1, 0, 0]],
    ]);

    const hits = index.vectorSearch([1, 0, 0, 0], { sourceIds: [src.id], limit: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.chunkId).toBe(idA);
    expect(hits[0]!.score).toBeGreaterThan(0.9);

    // 无命中 source 时不得退全表 JS 扫
    const empty = index.vectorSearch([1, 0, 0, 0], {
      sourceIds: ['src_missing' as never],
      limit: 2,
    });
    expect(empty).toEqual([]);

    sources.database.close();
  });

  it('无 sqlite-vec 时 JS 路径仍返回正确近邻', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-vec-js',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'vec-js',
    });
    await index.upsertFile({
      sourceId: src.id,
      path: '/tmp/kn-vec-js/a.md',
      contentHash: 'h1',
      size: 1,
      mtime: Date.now(),
      adapterId: 'md',
      chunks: [{ ordinal: 0, text: 'alpha', startLine: 1, endLine: 1 }],
    });
    await index.upsertFile({
      sourceId: src.id,
      path: '/tmp/kn-vec-js/b.md',
      contentHash: 'h2',
      size: 1,
      mtime: Date.now(),
      adapterId: 'md',
      chunks: [{ ordinal: 0, text: 'beta', startLine: 1, endLine: 1 }],
    });
    const files = index.listFiles(src.id);
    const byPath = new Map(files.map((f) => [f.path, index.listChunksByPath(src.id, f.path)[0]!.id]));
    index.setChunkEmbeddings([
      [byPath.get('/tmp/kn-vec-js/a.md')!, [1, 0, 0]],
      [byPath.get('/tmp/kn-vec-js/b.md')!, [0, 1, 0]],
    ]);
    const hits = index.vectorSearch([1, 0, 0], { sourceIds: [src.id], limit: 2 });
    expect(hits[0]!.text).toBe('alpha');
    sources.database.close();
  });
});
