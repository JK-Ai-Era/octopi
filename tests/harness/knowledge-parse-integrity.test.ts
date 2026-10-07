/**
 * Parse 完整性 — 半写入不半成品可搜 / gap 补扫 indexing / 入队层 size-mtime 跳过
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';
import type { KnowledgeChunkDraft } from '@octopi-agent/engine/harness/knowledge/adapters.js';

function draftChunks(n: number, seed = 'body'): KnowledgeChunkDraft[] {
  return Array.from({ length: n }, (_, i) => ({
    ordinal: i,
    text: `${seed} chunk ${i} unique-token-${seed}-${i}`,
    startLine: i * 2 + 1,
    endLine: i * 2 + 2,
    ftsToks: `unique-token-${seed}-${i}`,
  }));
}

describe('upsertFile 半写入完整性', () => {
  const dbs: KnowledgeDatabase[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
  });

  async function makeIndex(): Promise<{ db: KnowledgeDatabase; index: KnowledgeIndexStore }> {
    const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
    dbs.push(db);
    return { db, index: new KnowledgeIndexStore(db) };
  }

  it('批次中途 abort：清掉 partial，回到 indexing，检索不可见', async () => {
    const { db, index } = await makeIndex();
    const sourceId = 'src_abort';
    const path = '/virtual/abort.md';
    const chunks = draftChunks(120, 'abort');
    const controller = new AbortController();

    const p = index.upsertFile(
      {
        sourceId,
        path,
        contentHash: 'hash-abort',
        size: 100,
        mtime: 1,
        adapterId: 'markdown',
        chunks,
      },
      { batchSize: 50, signal: controller.signal },
    );
    // 首批同步写入后 yield；此处 abort 使下一批边界停住
    controller.abort();
    await expect(p).rejects.toThrow(/aborted/);

    const rec = index.getFile(sourceId, path);
    expect(rec?.status).toBe('indexing');
    expect(rec?.chunkCount).toBe(0);

    const chunkRows = db.raw
      .prepare('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE file_id = ?')
      .get(rec!.id) as { n: number };
    expect(chunkRows.n).toBe(0);

    // 半成品不得被搜到
    expect(index.search('unique-token-abort', { sourceIds: [sourceId] })).toHaveLength(0);
    // isFresh 不得误判为完成
    expect(index.isFresh(sourceId, path, 'hash-abort')).toBe(false);
  });

  it('预先 aborted：不留下可搜 partial', async () => {
    const { index } = await makeIndex();
    const controller = new AbortController();
    controller.abort();
    await expect(
      index.upsertFile(
        {
          sourceId: 'src_pre',
          path: '/virtual/pre.md',
          contentHash: 'h',
          size: 1,
          mtime: 1,
          adapterId: 'markdown',
          chunks: draftChunks(3, 'pre'),
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/aborted/);

    const rec = index.getFile('src_pre', '/virtual/pre.md');
    expect(rec?.status).toBe('indexing');
    expect(rec?.chunkCount).toBe(0);
    expect(index.search('unique-token-pre', { sourceIds: ['src_pre'] })).toHaveLength(0);
  });

  it('完整写入后 isFresh 成立且可搜', async () => {
    const { index } = await makeIndex();
    await index.upsertFile({
      sourceId: 'src_ok',
      path: '/virtual/ok.md',
      contentHash: 'hash-ok',
      size: 10,
      mtime: 2,
      adapterId: 'markdown',
      chunks: draftChunks(3, 'ok'),
    });
    const rec = index.getFile('src_ok', '/virtual/ok.md');
    expect(rec?.status).toBe('indexed');
    expect(rec?.chunkCount).toBe(3);
    expect(index.isFresh('src_ok', '/virtual/ok.md', 'hash-ok')).toBe(true);
    expect(index.search('unique-token-ok', { sourceIds: ['src_ok'] }).length).toBeGreaterThan(0);
  });

  it('pruneMissing 归一 Windows 路径：keep 反斜杠不得误删', async () => {
    const { index } = await makeIndex();
    await index.upsertFile({
      sourceId: 'src_prune',
      path: 'C:/data/docs/a.md',
      contentHash: 'h',
      size: 1,
      mtime: 1,
      adapterId: 'markdown',
      chunks: draftChunks(1, 'prune'),
    });
    // discover 在 Windows 上给出反斜杠 keep 集
    const removed = index.pruneMissing('src_prune', ['C:\\data\\docs\\a.md'], {
      allowEmptyKeep: true,
    });
    expect(removed).toBe(0);
    expect(index.getFile('src_prune', 'C:/data/docs/a.md')).not.toBeNull();
  });
});

describe('gap 扫描补 indexing + 入队层未变更跳过', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  async function makeIngest(): Promise<{
    root: string;
    store: KnowledgeSourceStore;
    ingest: KnowledgeIngest;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'octopi-kn-integrity-'));
    const store = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const ingest = new KnowledgeIngest({ sourceStore: store, parseConcurrency: 2 });
    cleanup = async () => {
      ingest.dispose();
      store.database.close();
      await rm(root, { recursive: true, force: true });
    };
    return { root, store, ingest };
  }

  function countParseJobs(store: KnowledgeSourceStore, sourceId: string): number {
    const row = store.database.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_jobs WHERE source_id = ? AND kind = 'parse_file'`,
      )
      .get(sourceId) as { n: number };
    return row.n;
  }

  it('已索引且 size/mtime 未变：再次 ingest 不入队 parse_file', async () => {
    const { root, store, ingest } = await makeIngest();
    const dir = join(root, 'docs');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.md'), '# A\n\nstable alpha content\n', 'utf8');
    await writeFile(join(dir, 'b.md'), '# B\n\nstable beta content\n', 'utf8');

    const src = store.register({
      kind: 'directory',
      location: dir,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'skip-unchanged',
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(10_000);
    const jobsAfterFirst = countParseJobs(store, src.id);
    expect(jobsAfterFirst).toBeGreaterThan(0);

    await ingest.ingestSource(src.id);
    await ingest.idle(10_000);
    expect(countParseJobs(store, src.id)).toBe(jobsAfterFirst);
  });

  it('文件变更后：再次 ingest 会重新入队并索引新内容', async () => {
    const { root, store, ingest } = await makeIngest();
    const dir = join(root, 'docs');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'a.md');
    await writeFile(file, '# A\n\nqqqaaa only in first draft\n', 'utf8');

    const src = store.register({
      kind: 'directory',
      location: dir,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'changed',
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(10_000);
    const jobsAfterFirst = countParseJobs(store, src.id);

    await writeFile(file, '# A\n\nwwwbbb only in second draft\n', 'utf8');
    // 确保 mtime 变化（部分 FS 粒度秒级）
    await utimes(file, new Date(), new Date());

    await ingest.ingestSource(src.id);
    await ingest.idle(10_000);
    expect(countParseJobs(store, src.id)).toBeGreaterThan(jobsAfterFirst);
    expect(ingest.indexStore.search('wwwbbb', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
    expect(ingest.indexStore.search('qqqaaa', { sourceIds: [src.id] }).length).toBe(0);
  });

  it('对账 prune：已从磁盘删除的文件不再留在索引', async () => {
    const { root, store, ingest } = await makeIngest();
    const dir = join(root, 'docs');
    await mkdir(dir, { recursive: true });
    const keep = join(dir, 'keep.md');
    const gone = join(dir, 'gone.md');
    await writeFile(keep, '# Keep\n\nstay searchable\n', 'utf8');
    await writeFile(gone, '# Gone\n\nshould be pruned\n', 'utf8');

    const src = store.register({
      kind: 'directory',
      location: dir,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'prune-deleted',
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(10_000);
    expect(ingest.indexStore.search('should be pruned', { sourceIds: [src.id] }).length).toBeGreaterThan(0);

    await rm(gone, { force: true });
    // 模拟 watch 漏事件：不 drop_file，只靠对账
    await ingest.reconcileJobs();
    await ingest.idle(10_000);

    expect(ingest.indexStore.getFile(src.id, gone)).toBeNull();
    expect(ingest.indexStore.search('should be pruned', { sourceIds: [src.id] })).toHaveLength(0);
    expect(ingest.indexStore.search('stay searchable', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
  });

  it('status=indexing 半成品：reconcile 缺口扫描补 parse', async () => {
    const { root, store, ingest } = await makeIngest();
    const dir = join(root, 'docs');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'stuck.md');
    await writeFile(file, '# Stuck\n\nneed reparsing body\n', 'utf8');

    const src = store.register({
      kind: 'directory',
      location: dir,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'stuck-indexing',
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(10_000);

    // 模拟崩溃半写入：indexing + 无 chunk
    const rec = ingest.indexStore.getFile(src.id, file)!;
    store.database.raw
      .prepare(
        `UPDATE knowledge_files SET status = 'indexing', chunk_count = 0, error = 'simulated_crash' WHERE id = ?`,
      )
      .run(rec.id);
    store.database.raw
      .prepare('DELETE FROM knowledge_chunks WHERE file_id = ?')
      .run(rec.id);

    expect(ingest.indexStore.search('need reparsing', { sourceIds: [src.id] })).toHaveLength(0);

    await ingest.reconcileJobs();
    await ingest.idle(10_000);

    const after = ingest.indexStore.getFile(src.id, file)!;
    expect(after.status).toBe('indexed');
    expect(after.chunkCount).toBeGreaterThan(0);
    expect(ingest.indexStore.search('need reparsing', { sourceIds: [src.id] }).length).toBeGreaterThan(
      0,
    );
  });
});
