/**
 * ingest 看门狗：缺向量且队列空时必须自动续跑
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kn-recon-'));
  await writeFile(join(root, 'a.md'), 'hello widgets', 'utf8');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('KnowledgeIngest.reconcileJobs', () => {
  it('缺向量且无 embed 任务时自动排队', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const filePath = join(root, 'a.md');
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'recon',
    });
    index.upsertFile({
      sourceId: src.id,
      path: filePath,
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

    await ingest.reconcileJobs();
    // kick 后可能立刻跑完；断言「续跑链路被触发」：有 embed job 或已有向量
    const job = sources.database.raw
      .prepare("SELECT COUNT(*) AS n FROM knowledge_jobs WHERE kind = 'embed_source'")
      .get() as { n: number };
    const emb = sources.database.raw
      .prepare('SELECT COUNT(*) AS n FROM knowledge_chunk_embeddings')
      .get() as { n: number };
    expect(job.n + emb.n).toBeGreaterThan(0);
  });

  it('超时 running 会被收回 queued', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'recon2',
    });
    const old = Date.now() - 10 * 60_000;
    sources.database.raw
      .prepare(
        `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
         VALUES ('kj_stale', ?, 'embed_source', NULL, 3, 'running', 0, ?, ?)`,
      )
      .run(src.id, old, old);

    const ingest = new KnowledgeIngest({ sourceStore: sources, indexStore: index });
    await ingest.reconcileJobs();
    const row = sources.database.raw
      .prepare("SELECT status, updated_at FROM knowledge_jobs WHERE id = 'kj_stale'")
      .get() as { status: string; updated_at: number };
    // reclaim 后 kick 可能立刻再 claim；关键是不再是陈旧 running
    expect(row.updated_at).toBeGreaterThan(old);
    expect(['queued', 'running', 'done', 'failed']).toContain(row.status);
  });

  it('gap 扫描会重试 oversize skipped（配置调宽后可进索引）', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const filePath = join(root, 'a.md');
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'recon-oversize',
    });
    // 模拟旧策略：oversize skip 且未记录 size
    index.markFileSkipped(src.id, filePath, 'oversize', 0);

    const ingest = new KnowledgeIngest({ sourceStore: sources, indexStore: index });
    await ingest.reconcileJobs();
    const job = sources.database.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_jobs
         WHERE source_id = ? AND kind = 'parse_file' AND path = ?`,
      )
      .get(src.id, filePath) as { n: number };
    expect(job.n).toBeGreaterThan(0);
  });
});
