/**
 * Vector ANN-lite：桶分区裁剪 + 邻桶扩展；向量写入带 bucket
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import {
  queryBuckets,
  scoreAnnCandidates,
  vectorBucket,
} from '@octopi-agent/engine/harness/knowledge/vector-ann.js';

describe('vector ANN-lite', () => {
  it('vectorBucket 稳定；queryBuckets 含主桶与邻桶', () => {
    const v = [1, 0.5, -0.2, 0, 0, 0, 0, 0, 9, 9];
    const b = vectorBucket(v);
    expect(b).toBe(vectorBucket([...v]));
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(256);
    const q = queryBuckets(v);
    expect(q).toContain(b);
    expect(q.length).toBeGreaterThan(1);
    expect(q.length).toBeLessThanOrEqual(9);
  });

  it('写入向量带 bucket；邻桶可命中相近向量', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-ann',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'ann',
    });

    // 同簇向量（应落同/邻桶）
    const base = [1, 0.2, -0.1, 0.05, 0, 0, 0, 0];
    const near = [1, 0.21, -0.09, 0.06, 0, 0, 0, 0];
    // 远簇
    const far = [-1, -0.2, 0.1, -0.05, 0, 0, 0, 0];

    index.upsertFile({
      sourceId: src.id,
      path: '/tmp/kn-ann/a.md',
      contentHash: 'h1',
      size: 1,
      mtime: Date.now(),
      adapterId: 'markdown',
      chunks: [{ ordinal: 0, text: 'near a', startLine: 1, endLine: 1 }],
    });
    index.upsertFile({
      sourceId: src.id,
      path: '/tmp/kn-ann/b.md',
      contentHash: 'h2',
      size: 1,
      mtime: Date.now(),
      adapterId: 'markdown',
      chunks: [{ ordinal: 0, text: 'near b', startLine: 1, endLine: 1 }],
    });
    index.upsertFile({
      sourceId: src.id,
      path: '/tmp/kn-ann/c.md',
      contentHash: 'h3',
      size: 1,
      mtime: Date.now(),
      adapterId: 'markdown',
      chunks: [{ ordinal: 0, text: 'far c', startLine: 1, endLine: 1 }],
    });

    const files = index.listFiles(src.id);
    const chunksByPath = new Map(
      files.map((f) => [f.path, index.listChunksByPath(src.id, f.path).map((c) => c.id)]),
    );
    const idA = chunksByPath.get('/tmp/kn-ann/a.md')![0];
    const idB = chunksByPath.get('/tmp/kn-ann/b.md')![0];
    const idC = chunksByPath.get('/tmp/kn-ann/c.md')![0];

    index.setChunkEmbeddings([
      [idA, near],
      [idB, base],
      [idC, far],
    ]);

    const row = sources.database.raw
      .prepare(`SELECT bucket FROM knowledge_chunk_embeddings WHERE chunk_id = ?`)
      .get(idA) as { bucket: number };
    expect(row.bucket).toBe(vectorBucket(near));

    // 查询 base：近邻 a/b 应排在 c 前
    const hits = index.vectorSearch(base, { sourceIds: [src.id], limit: 3 });
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const order = hits.map((h) => h.chunkId);
    expect(order.indexOf(idC as never)).toBeGreaterThan(order.indexOf(idA as never));
    expect(order.indexOf(idC as never)).toBeGreaterThan(order.indexOf(idB as never));

    sources.database.close();
  });

  it('scoreAnnCandidates 只认对齐维度并 top-k 截断', () => {
    const q = [1, 0, 0];
    const rows = [
      { id: 'a', embedding: [1, 0, 0] },
      { id: 'b', embedding: [0.9, 0.1, 0] },
      { id: 'bad', embedding: [1, 0] },
    ];
    const scored = scoreAnnCandidates(q, rows, 1);
    expect(scored.length).toBe(1);
    expect(scored[0].id).toBe('a');
  });
});
