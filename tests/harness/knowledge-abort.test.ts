/**
 * 索引任务手动中止
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';

describe('KnowledgeIngest.abortJobs', () => {
  it('清空 queued 并标记 cancelled，中止后不再续跑 embed', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-abort',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'abort-me',
    });
    index.upsertFile({
      sourceId: src.id,
      path: '/tmp/kn-abort/a.md',
      contentHash: 'h',
      size: 1,
      mtime: Date.now(),
      adapterId: 'md',
      chunks: [{ ordinal: 0, text: 'hello widgets', startLine: 1, endLine: 1 }],
    });

    const ingest = new KnowledgeIngest({
      sourceStore: sources,
      indexStore: index,
      embeddingProvider: {
        name: 'fake',
        dimensions: 2,
        async embed() {
          return [0, 1];
        },
        async embedBatch(ts: string[]) {
          return ts.map(() => [0, 1]);
        },
      },
    });

    sources.database.raw
      .prepare(
        `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
         VALUES ('kj_q1', ?, 'parse_file', '/tmp/kn-abort/a.md', 2, 'queued', 0, ?, ?)`,
      )
      .run(src.id, Date.now(), Date.now());
    sources.database.raw
      .prepare(
        `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
         VALUES ('kj_q2', ?, 'embed_source', NULL, 3, 'queued', 0, ?, ?)`,
      )
      .run(src.id, Date.now(), Date.now());

    const r = ingest.abortJobs({ sourceId: src.id });
    expect(r.cancelledQueued).toBe(2);

    const rows = sources.database.raw
      .prepare("SELECT status FROM knowledge_jobs WHERE id IN ('kj_q1','kj_q2')")
      .all() as Array<{ status: string }>;
    expect(rows.every((x) => x.status === 'cancelled')).toBe(true);

    // 中止后 enqueue 不应再写入
    ingest.abortJobs({ sourceId: src.id });
    await ingest.reconcileJobs();
    const still = sources.database.raw
      .prepare(
        "SELECT COUNT(*) AS n FROM knowledge_jobs WHERE source_id = ? AND status IN ('queued','running')",
      )
      .get(src.id) as { n: number };
    expect(still.n).toBe(0);
  });
});
