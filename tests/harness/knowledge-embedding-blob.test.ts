/**
 * Float32 BLOB 向量读写 + 检索
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';

describe('chunk embeddings as Float32 BLOB', () => {
  it('写入 BLOB 并向量检索命中', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-blob',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'blob',
    });
    await index.upsertFile({
      sourceId: src.id,
      path: '/tmp/kn-blob/a.md',
      contentHash: 'h',
      size: 1,
      mtime: Date.now(),
      adapterId: 'md',
      chunks: [
        { ordinal: 0, text: 'alpha', startLine: 1, endLine: 1 },
        { ordinal: 1, text: 'beta', startLine: 2, endLine: 2 },
      ],
    });
    const chunks = index.listChunksByPath(src.id, '/tmp/kn-blob/a.md');
    index.setChunkEmbedding(chunks[0].id, [1, 0, 0]);
    index.setChunkEmbedding(chunks[1].id, [0, 1, 0]);

    const row = sources.database.raw
      .prepare('SELECT embedding, dimensions FROM knowledge_chunk_embeddings LIMIT 1')
      .get() as { embedding: Uint8Array; dimensions: number };
    expect(row.dimensions).toBe(3);
    expect(row.embedding.byteLength).toBe(12); // 3 × float32

    const hits = index.vectorSearch([1, 0, 0], { sourceIds: [src.id], limit: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toBe('alpha');
    expect(hits[0].score).toBeGreaterThan(0.9);
  });
});
