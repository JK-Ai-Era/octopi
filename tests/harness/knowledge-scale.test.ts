/**
 * T4 可扩展：catalog 抽样、coverage 合并刷新、jobs 清理、缺口扫描按源、settled 不依赖 embedding
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kn-t4-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  for (let i = 0; i < 5; i++) {
    await writeFile(join(root, 'docs', `guide-${i}.md`), `# guide ${i}\n\ncontent ${i}\n`, 'utf8');
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('knowledge scale fixes', () => {
  it('catalog topics 抽样而非全表；短 TTL 内稳定', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 't4-catalog',
    });
    for (let i = 0; i < 30; i++) {
      index.upsertFile({
        sourceId: src.id,
        path: join(root, 'docs', `file-${i}.md`),
        contentHash: `h${i}`,
        size: 1,
        mtime: Date.now(),
        adapterId: 'markdown',
        chunks: [{ ordinal: 0, text: 'x', startLine: 1, endLine: 1 }],
      });
    }
    const items = sources.catalogFor('a1');
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].topics?.length).toBeGreaterThan(0);
    // TTL 内重复调用不抛、结果一致
    const again = sources.catalogFor('a1');
    expect(again[0].topics).toEqual(items[0].topics);
    sources.database.close();
  });

  it('reconcile 清理过期终态 job', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 't4-jobs',
    });
    const old = Date.now() - 48 * 60 * 60_000;
    sources.database.raw
      .prepare(
        `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
         VALUES ('kj_old_done', ?, 'parse_file', '/x.md', 2, 'done', 0, ?, ?)`,
      )
      .run(src.id, old, old);
    sources.database.raw
      .prepare(
        `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
         VALUES ('kj_old_fail', ?, 'parse_file', '/z.md', 2, 'failed', 1, ?, ?)`,
      )
      .run(src.id, old, old);

    const ingest = new KnowledgeIngest({ sourceStore: sources, indexStore: index });
    try {
      await ingest.reconcileJobs();
      const oldJob = sources.database.raw
        .prepare(`SELECT COUNT(*) AS n FROM knowledge_jobs WHERE id IN ('kj_old_done','kj_old_fail')`)
        .get() as { n: number };
      expect(oldJob.n).toBe(0);
    } finally {
      ingest.dispose();
      sources.database.close();
    }
  });

  it('纯关键词部署也会触发 onSourceSettled', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: join(root, 'docs'),
      scopeRef: { level: 'global', key: 'global' },
      displayName: 't4-settled',
    });
    const settled: string[] = [];
    const ingest = new KnowledgeIngest({
      sourceStore: sources,
      indexStore: index,
      // 无 embeddingProvider
    });
    ingest.onSourceSettled = (id) => {
      settled.push(id);
    };
    try {
      await ingest.ingestSource(src.id);
      await ingest.idle(8_000);
      await ingest.reconcileJobs();
      expect(settled).toContain(src.id);
    } finally {
      ingest.dispose();
      sources.database.close();
    }
  });

  it('countQueuedKinds 按源隔离：A 源积压不挡 B 源缺口扫描', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const srcA = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 't4-a',
    });
    const srcB = sources.register({
      kind: 'directory',
      location: join(root, 'docs'),
      scopeRef: { level: 'global', key: 'global' },
      displayName: 't4-b',
    });
    // A 积压
    sources.database.raw
      .prepare(
        `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
         VALUES ('kj_a', ?, 'parse_file', '/a.md', 2, 'queued', 0, ?, ?)`,
      )
      .run(srcA.id, Date.now(), Date.now());

    const ingest = new KnowledgeIngest({ sourceStore: sources, indexStore: index });
    try {
      // 私有方法不可直接测；通过 reconcile 对 B 做缺口扫描仍能入队来验证
      await ingest.reconcileJobs();
      const bJobs = sources.database.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_jobs WHERE source_id = ? AND kind = 'parse_file'`,
        )
        .get(srcB.id) as { n: number };
      // B 源磁盘上有 5 个 md，缺口扫描应能入队（未被 A 的积压全局挡住）
      expect(bJobs.n).toBeGreaterThan(0);
    } finally {
      ingest.dispose();
      sources.database.close();
    }
  });
});
