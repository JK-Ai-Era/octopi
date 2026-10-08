/**
 * 缺口补扫不得被「队列里还有 parse_file」挡住 — watch 漏事件后应立刻补，而不是排空才一次入队
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';

describe('knowledge parse gap scan', () => {
  it('parse_file 排队中仍可补扫缺口（不被门闩挡住）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-gap-'));
    const corpus = join(dir, 'corpus');
    await mkdir(corpus, { recursive: true });
    // 模拟 watch 只抓到 1 个，磁盘上其实有 5 个
    for (let i = 0; i < 5; i++) {
      await writeFile(join(corpus, `f-${i}.md`), `# t${i}\n\nbody-${i}\n`, 'utf8');
    }

    const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
    const sources = new KnowledgeSourceStore(db);
    const index = new KnowledgeIndexStore(db);
    const ingest = new KnowledgeIngest({
      sourceStore: sources,
      indexStore: index,
      parseConcurrency: 1,
      documentParseConcurrency: 1,
      embeddingProvider: null,
    });

    const src = sources.register({
      kind: 'directory',
      location: corpus,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'gap',
    });

    // 模拟 watch 已入队 1 条 parse_file（其余漏事件）
    const { JobQueue } = await import('@octopi-agent/engine/harness/knowledge/job-queue.js');
    // 直接 enqueue 一条（会进 jobs 表）
    // KnowledgeIngest.enqueue 是 private；用 reprocessFiles 路径不行，这里手写 SQL 等价入队
    db.raw
      .prepare(
        `INSERT INTO knowledge_jobs (id, source_id, file_id, kind, path, priority, status, attempts, created_at, updated_at)
         VALUES ('kj_gap1', ?, NULL, 'parse_file', ?, 1, 'queued', 0, ?, ?)`,
      )
      .run(src.id, join(corpus, 'f-0.md').replace(/\\/g, '/'), Date.now(), Date.now());

    const queuedBefore = (
      db.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_jobs WHERE source_id = ? AND kind = 'parse_file' AND status = 'queued'`,
        )
        .get(src.id) as { n: number }
    ).n;
    expect(queuedBefore).toBe(1);

    // 触发缺口补扫：即使有 queued parse_file，也必须补上磁盘有、索引无的 4 个
    const added = await (
      ingest as unknown as { ensureParseCoverage(id: string): Promise<number> }
    ).ensureParseCoverage(src.id);
    expect(added).toBeGreaterThanOrEqual(4);

    const queuedAfter = (
      db.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_jobs WHERE source_id = ? AND kind = 'parse_file' AND status = 'queued'`,
        )
        .get(src.id) as { n: number }
    ).n;
    expect(queuedAfter).toBeGreaterThanOrEqual(5);

    ingest.dispose();
    db.close();
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
});
