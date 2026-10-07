/**
 * 中止/继续互斥读数 + 目录不得进 knowledge_files
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';

let root: string;
let subDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kn-ctrl-'));
  subDir = join(root, 'nested-dir');
  await mkdir(subDir);
  await writeFile(join(subDir, 'a.md'), 'hello', 'utf8');
  await writeFile(join(root, 'b.md'), 'world', 'utf8');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('KnowledgeIngest jobControlState', () => {
  it('中止/继续 互斥：有活可中止，无活可继续，二者不同时为 true', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'ctrl',
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

    // 无任务：可继续（缺向量）或都不可用；至少不同时 true
    const idle = ingest.jobControlState(src.id);
    expect(idle.canAbort && idle.canResume).toBe(false);

    sources.database.raw
      .prepare(
        `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
         VALUES ('kj_run1', ?, 'embed_source', NULL, 3, 'running', 0, ?, ?)`,
      )
      .run(src.id, Date.now(), Date.now());
    const active = ingest.jobControlState(src.id);
    expect(active.canAbort).toBe(true);
    expect(active.canResume).toBe(false);

    ingest.abortJobs({ sourceId: src.id });
    const afterAbort = ingest.jobControlState(src.id);
    expect(afterAbort.aborted).toBe(true);
    expect(afterAbort.canAbort).toBe(false);
    expect(afterAbort.canResume).toBe(true);
  });
});

describe('directory paths must not enter knowledge_files', async () => {
  it('parseOne(目录) 不写 no_adapter，且清历史脏行', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'dir-clean',
    });
    // 模拟历史脏数据：目录被标成 no_adapter
    index.markFileSkipped(src.id, subDir, 'no_adapter', 0);

    const ingest = new KnowledgeIngest({ sourceStore: sources, indexStore: index });
    await ingest.ingestFileNow(src.id, subDir);

    const row = sources.database.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_memberships m
         JOIN knowledge_files f ON f.id = m.file_id
         WHERE m.source_id = ? AND m.logical_path = ?`,
      )
      .get(src.id, subDir) as { n: number };
    expect(row.n).toBe(0);
  });

  it('cleanupNonFileIndexRows 删除目录脏行、保留真实文件', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'dir-sweep',
    });
    const filePath = join(root, 'b.md');
    index.markFileSkipped(src.id, filePath, 'no_adapter', 5);
    // 构造后再次写入目录脏行，验证显式清理
    const ingest = new KnowledgeIngest({ sourceStore: sources, indexStore: index });
    index.markFileSkipped(src.id, subDir, 'no_adapter', 0);
    const removed = ingest.cleanupNonFileIndexRows(src.id);
    expect(removed).toBeGreaterThanOrEqual(1);

    const dirLeft = sources.database.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_memberships WHERE logical_path = ?`,
      )
      .get(subDir.replace(/\\/g, '/')) as { n: number };
    const fileLeft = sources.database.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_memberships WHERE logical_path = ?`,
      )
      .get(filePath.replace(/\\/g, '/')) as { n: number };
    expect(dirLeft.n).toBe(0);
    expect(fileLeft.n).toBe(1);
  });

  it('reprocessFiles 强制入队 parse 并失效 contentHash', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'repro',
    });
    const filePath = join(root, 'b.md');
    await index.upsertFile({
      sourceId: src.id,
      path: filePath,
      contentHash: 'old-hash',
      size: 5,
      mtime: Date.now(),
      adapterId: 'md',
      chunks: [{ ordinal: 0, text: 'world', startLine: 1, endLine: 1 }],
    });
    const ingest = new KnowledgeIngest({ sourceStore: sources, indexStore: index });
    const r = ingest.reprocessFiles(src.id, [filePath, join(root, 'missing.md')]);
    expect(r.queued).toBe(2);
    expect(r.resumed).toBe(false);
    expect(r.cleanedNonFiles).toBe(0);

    const row = sources.database.raw
      .prepare(
        `SELECT f.content_hash AS content_hash, f.chunk_count AS chunk_count
         FROM knowledge_memberships m
         JOIN knowledge_files f ON f.id = m.file_id
         WHERE m.logical_path = ?`,
      )
      .get(filePath.replace(/\\/g, '/')) as
      | { content_hash: string; chunk_count: number }
      | undefined;
    expect(row?.content_hash).toBe('');
    expect(row?.chunk_count).toBe(1); // 旧 chunk 保留到 upsert

    const jobs = sources.database.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_jobs WHERE kind = 'parse_file' AND status = 'queued'`,
      )
      .get() as { n: number };
    expect(jobs.n).toBeGreaterThan(0);
  });

  it('中止后 reprocess 会自动 resume 并可靠入队（不静默丢弃）', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'repro-abort',
    });
    const filePath = join(root, 'b.md');
    const ingest = new KnowledgeIngest({ sourceStore: sources, indexStore: index });
    ingest.abortJobs({ sourceId: src.id });
    expect(ingest.jobControlState(src.id).aborted).toBe(true);

    const r = ingest.reprocessFiles(src.id, [filePath]);
    expect(r.resumed).toBe(true);
    expect(r.queued).toBe(1);
    expect(r.alreadyActive).toBe(0);
    expect(ingest.jobControlState(src.id).aborted).toBe(false);

    // 再点重做：应在队列，不重复入队
    const r2 = ingest.reprocessFiles(src.id, [filePath]);
    expect(r2.queued).toBe(0);
    expect(r2.alreadyActive).toBe(1);

    // 目录脏行：清掉而不是假装入队
    const r3 = ingest.reprocessFiles(src.id, [subDir]);
    expect(r3.queued).toBe(0);
    expect(r3.cleanedNonFiles).toBe(1);

    const jobs = sources.database.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_jobs
         WHERE source_id = ? AND kind = 'parse_file' AND path = ? AND status = 'queued'`,
      )
      .get(src.id, filePath) as { n: number };
    expect(jobs.n).toBe(1);
  });

  it('reprocess 拒绝源 root 外路径（防越权读盘）', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'repro-acl',
    });
    const ingest = new KnowledgeIngest({ sourceStore: sources, indexStore: index });

    const outside = join(tmpdir(), 'octopi-secret-should-not-index.md');
    await writeFile(outside, 'apiKey=sk-should-never-enter', 'utf8');
    try {
      const r = ingest.reprocessFiles(src.id, [outside, join(root, 'b.md')]);
      expect(r.rejected).toBe(1);
      expect(r.queued).toBe(1);
      // 越权路径不得产生任何 parse 任务
      const leaked = sources.database.raw
        .prepare('SELECT COUNT(*) AS n FROM knowledge_jobs WHERE path = ?')
        .get(outside) as { n: number };
      expect(leaked.n).toBe(0);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('parseOne 对源外路径直接抛错（防御深度）', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'parse-acl',
    });
    const ingest = new KnowledgeIngest({ sourceStore: sources, indexStore: index });

    const outside = join(tmpdir(), 'octopi-parse-outside.md');
    await writeFile(outside, 'should not parse', 'utf8');
    try {
      // 绕过 reprocess 直接污染队列，检验 parseOne 闸门
      sources.database.raw
        .prepare(
          `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
           VALUES ('kj_evil', ?, 'parse_file', ?, 1, 'queued', 0, ?, ?)`,
        )
        .run(src.id, outside, Date.now(), Date.now());
      ingest.kick();
      await ingest.idle(5_000);

      // 不得写入 knowledge_files / chunks
      const files = sources.database.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_memberships WHERE logical_path = ?`,
        )
        .get(outside.replace(/\\/g, '/')) as { n: number };
      expect(files.n).toBe(0);
      const chunks = sources.database.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_chunks c
           JOIN knowledge_memberships m ON m.file_id = c.file_id
           WHERE m.logical_path = ?`,
        )
        .get(outside.replace(/\\/g, '/')) as { n: number };
      expect(chunks.n).toBe(0);
      // job 以 failed 收场（path not owned）
      const job = sources.database.raw
        .prepare(`SELECT status, last_error FROM knowledge_jobs WHERE id = 'kj_evil'`)
        .get() as { status: string; last_error: string | null } | undefined;
      expect(job?.status).toBe('failed');
      expect(job?.last_error).toMatch(/not owned/i);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('外源 reprocess 只接受已登记逻辑键，并走 fetch_doc', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'url',
      location: 'https://docs.example.com/api',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'remote-repro',
    });
    await index.upsertFile({
      sourceId: src.id,
      path: '/api/guide.md',
      contentHash: 'h',
      size: 10,
      mtime: Date.now(),
      adapterId: 'markdown',
      chunks: [{ ordinal: 0, text: 'guide', startLine: 1, endLine: 1 }],
    });
    const ingest = new KnowledgeIngest({ sourceStore: sources, indexStore: index });

    // 未登记逻辑键 + 任意本地路径都拒绝
    const r = ingest.reprocessFiles(src.id, ['/api/unknown.md', join(root, 'b.md')]);
    expect(r.rejected).toBe(2);
    expect(r.queued).toBe(0);

    // 已登记逻辑键 → fetch_doc，且不是 parse_file
    const r2 = ingest.reprocessFiles(src.id, ['/api/guide.md']);
    expect(r2.queued).toBe(1);
    expect(r2.rejected).toBe(0);
    const job = sources.database.raw
      .prepare(`SELECT kind FROM knowledge_jobs WHERE path = '/api/guide.md' AND status = 'queued'`)
      .get() as { kind: string } | undefined;
    expect(job?.kind).toBe('fetch_doc');
  });
});
