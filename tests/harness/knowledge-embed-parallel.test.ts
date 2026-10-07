/**
 * embedding 不得等全部 parse 结束 — 大库 parse 饿死向量回填
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';
import type { EmbeddingProvider } from '@octopi-agent/engine/harness/memory/sqlite/embedding.js';

function stubEmbedder(): EmbeddingProvider {
  let n = 0;
  return {
    name: 'stub',
    dimensions: 4,
    async embed() {
      n += 1;
      return [n, 0.1, 0.2, 0.3];
    },
    async embedBatch(texts: string[]) {
      return texts.map((_, i) => [i + n, 0.1, 0.2, 0.3]);
    },
  };
}

describe('embed runs while parse queue is non-empty', () => {
  it('parse 并行时 embed_source 仍可认领并写向量', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kn-embed-parallel-'));
    try {
      for (let i = 0; i < 12; i++) {
        await writeFile(join(root, `f${i}.md`), `# doc ${i}\n\nunique body ${i} for embed parallel\n`, 'utf8');
      }
      const store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
      const ingest = new KnowledgeIngest({
        sourceStore: store,
        embeddingProvider: stubEmbedder(),
        embedBatch: 2,
        embedConcurrency: 1,
        parseConcurrency: 1,
        parseTimeoutMs: 30_000,
      });
      const src = store.register({
        kind: 'directory',
        location: root,
        scopeRef: { level: 'global', key: 'global' },
        displayName: 'embed-parallel',
      });
      await ingest.ingestSource(src.id);

      let sawParallel = false;
      let embeddings = 0;
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const active = store.database.raw
          .prepare(
            `SELECT
               SUM(CASE WHEN kind='parse_file' AND status IN ('queued','running') THEN 1 ELSE 0 END) AS parse,
               SUM(CASE WHEN kind='embed_source' AND status IN ('queued','running') THEN 1 ELSE 0 END) AS embed
             FROM knowledge_jobs WHERE source_id = ?`,
          )
          .get(src.id) as { parse: number | null; embed: number | null };
        const emb = store.database.raw
          .prepare('SELECT COUNT(*) AS n FROM knowledge_chunk_embeddings')
          .get() as { n: number };
        embeddings = emb.n;
        if (embeddings > 0 && (active.parse ?? 0) > 0) {
          sawParallel = true;
          break;
        }
        if ((active.parse ?? 0) === 0 && embeddings > 0) break;
      }

      expect(sawParallel).toBe(true);
      expect(embeddings).toBeGreaterThan(0);
      ingest.dispose();
      store.database.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
