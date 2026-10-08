/**
 * purge ∥ parse 竞态 — 让出窗口内 upsert 不得留下孤儿 FTS/悬空 membership
 */
import { describe, expect, it } from 'vitest';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';

function chunks(n: number, tag: string) {
  return Array.from({ length: n }, (_, i) => ({
    ordinal: i,
    text: `${tag} body-${i} race-token-${tag}-${i}`,
    startLine: i + 1,
    endLine: i + 1,
  }));
}

function orphanFtsCount(db: KnowledgeDatabase): number {
  const r = db.raw
    .prepare(
      `SELECT COUNT(*) AS n FROM knowledge_chunks_fts f
       LEFT JOIN knowledge_chunks c ON c.id = f.chunk_id
       WHERE c.id IS NULL`,
    )
    .get() as { n: number };
  return Number(r.n ?? 0);
}

function danglingMembershipCount(db: KnowledgeDatabase): number {
  const r = db.raw
    .prepare(
      `SELECT COUNT(*) AS n FROM knowledge_memberships m
       LEFT JOIN knowledge_files f ON f.id = m.file_id
       WHERE f.id IS NULL`,
    )
    .get() as { n: number };
  return Number(r.n ?? 0);
}

function chunkRows(db: KnowledgeDatabase, pathSuffix: string): number {
  const r = db.raw
    .prepare(
      `SELECT COUNT(*) AS n FROM knowledge_chunks c
       JOIN knowledge_memberships m ON m.file_id = c.file_id
       WHERE m.logical_path LIKE ?`,
    )
    .get(`%${pathSuffix}`) as { n: number };
  return Number(r.n ?? 0);
}

describe('purge ∥ parse race', () => {
  it('upsert 落在 purge dropChunks 让出窗口时，不得留下孤儿 FTS / 悬空 membership', async () => {
    const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
    const sources = new KnowledgeSourceStore(db);
    const index = new KnowledgeIndexStore(db);
    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-race',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'race',
    });
    const path = '/tmp/kn-race/big.md';

    // 初始大文件：>400 chunk，强制 dropChunksAsync 中途 setImmediate
    await index.upsertFile({
      sourceId: src.id,
      path,
      contentHash: 'old',
      size: 1,
      mtime: 1,
      adapterId: 'md',
      chunks: chunks(900, 'old'),
    });
    const fileId = index.getFile(src.id, path)!.id;

    // 同 file_id：purge 与 upsert 并行（模拟 drop_file ∥ parse 同物理文件）
    const purgeP = index.purgeFileAsync(fileId);
    const upsertP = index.upsertFile({
      sourceId: src.id,
      path,
      contentHash: 'new',
      size: 2,
      mtime: 2,
      adapterId: 'md',
      chunks: chunks(900, 'new'),
    });
    await Promise.all([purgeP, upsertP]);

    // 约束：库里不得有「FTS 行指向不存在 chunk」或「membership 指向不存在 file」
    expect(orphanFtsCount(db)).toBe(0);
    expect(danglingMembershipCount(db)).toBe(0);

    // 若 membership + file 仍在，则 chunk 与 FTS 必须一致（可搜语义完整）
    const rec = index.getFile(src.id, path);
    if (rec) {
      expect(rec.status).toBe('indexed');
      expect(rec.chunkCount).toBeGreaterThan(0);
      const n = chunkRows(db, 'big.md');
      expect(n).toBe(rec.chunkCount);
    }

    // 若已彻底 purge，则 chunks/FTS 不得残留该 file
    if (!rec) {
      expect(chunkRows(db, 'big.md')).toBe(0);
      expect(orphanFtsCount(db)).toBe(0);
    }

    db.close();
  });

  it('purge 后立刻同 path 重 parse：状态与检索一致', async () => {
    const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
    const sources = new KnowledgeSourceStore(db);
    const index = new KnowledgeIndexStore(db);
    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-race2',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'race2',
    });
    const path = '/tmp/kn-race2/re.md';
    await index.upsertFile({
      sourceId: src.id,
      path,
      contentHash: 'a',
      size: 1,
      mtime: 1,
      adapterId: 'md',
      chunks: chunks(800, 'a'),
    });
    const fileId = index.getFile(src.id, path)!.id;

    // 不 await purge，立刻重 upsert（watch drop_file + 缺口补扫同刻）
    const p1 = index.purgeFileAsync(fileId);
    const p2 = index.upsertFile({
      sourceId: src.id,
      path,
      contentHash: 'b',
      size: 2,
      mtime: 2,
      adapterId: 'md',
      chunks: chunks(800, 'b'),
    });
    await Promise.all([p1, p2]);

    expect(orphanFtsCount(db)).toBe(0);
    expect(danglingMembershipCount(db)).toBe(0);

    const rec = index.getFile(src.id, path);
    // 最终必须是「完整可搜」或「彻底不存在」，不得半写入
    if (rec) {
      expect(['indexed', 'indexing']).toContain(rec.status);
      if (rec.status === 'indexed') {
        expect(chunkRows(db, 're.md')).toBe(rec.chunkCount);
      }
    }

    db.close();
  });
});
