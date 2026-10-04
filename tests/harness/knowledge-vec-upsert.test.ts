/**
 * sqlite-vec 写入：禁止 UPSERT，必须 DELETE + INSERT；清理与回填
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kn-vec-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe('knowledge_vec upsert (DELETE+INSERT)', () => {
  it('setChunkEmbeddings 写入 vec 表；upsertFile 替换后不留旧 vec 行', async () => {
    const kdb = await KnowledgeDatabase.create({
      dbPath: join(dir, 'knowledge.db'),
      sqliteVec: true,
    });
    if (!kdb.sqliteVecEnabled) {
      // 环境无 sqlite-vec 扩展：跳过（可选依赖不当失败）
      return;
    }
    const sources = new KnowledgeSourceStore(kdb);
    const index = new KnowledgeIndexStore(kdb);
    const src = sources.register({
      kind: 'file',
      location: '/tmp/a.md',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'vec',
    });

    index.upsertFile({
      sourceId: src.id,
      path: '/tmp/a.md',
      contentHash: 'h1',
      size: 3,
      mtime: Date.now(),
      adapterId: 'md',
      chunks: [
        { ordinal: 0, text: 'alpha', startLine: 1, endLine: 1 },
        { ordinal: 1, text: 'beta', startLine: 2, endLine: 2 },
      ],
    });
    const chunks = index.listChunksByPath(src.id, '/tmp/a.md');
    expect(chunks.length).toBe(2);
    const dim = 4;
    const mk = (seed: number) => Array.from({ length: dim }, (_, i) => (i + seed) * 0.1);
    index.setChunkEmbeddings(chunks.map((c, i) => [String(c.id), mk(i + 1)]));

    const vecN = () =>
      Number((kdb.raw.prepare('SELECT COUNT(*) AS n FROM knowledge_vec').get() as { n: number }).n);
    expect(vecN()).toBe(2);

    // 同路径 upsert：旧 chunk/vec 必须清掉
    index.upsertFile({
      sourceId: src.id,
      path: '/tmp/a.md',
      contentHash: 'h2',
      size: 3,
      mtime: Date.now(),
      adapterId: 'md',
      chunks: [{ ordinal: 0, text: 'gamma', startLine: 1, endLine: 1 }],
    });
    expect(vecN()).toBe(0);
    const chunks2 = index.listChunksByPath(src.id, '/tmp/a.md');
    index.setChunkEmbeddings(chunks2.map((c) => [String(c.id), mk(9)]));
    expect(vecN()).toBe(1);

    // backfill：删 vec 后可从 BLOB 恢复（异步小批量）
    kdb.raw.prepare('DELETE FROM knowledge_vec').run();
    expect(vecN()).toBe(0);
    const n = await index.backfillVecFromEmbeddings(100);
    expect(n).toBeGreaterThan(0);
    expect(vecN()).toBe(n);
  });
});
