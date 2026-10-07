/**
 * 旧库迁移：无 bucket 列的 knowledge_chunk_embeddings 必须能升级
 * （CREATE INDEX 不得在 ALTER 之前执行）
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';

describe('knowledge.db bucket migration', () => {
  it('opens legacy embeddings table without bucket and upgrades', async () => {
    // 先用 :memory: 建「旧 schema」再 attach 不行——直接建临时文件更稳
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'kn-mig-'));
    const dbPath = join(dir, 'knowledge.db');

    // 模拟旧版：无 bucket 列
    const { DatabaseSync } = await import('node:sqlite');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE knowledge_chunk_embeddings (
        chunk_id   TEXT PRIMARY KEY,
        dimensions INTEGER NOT NULL,
        embedding  BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    legacy.close();

    // 新代码打开：createTables 的 CREATE INDEX 不得炸，migrate 应补列
    const kdb = await KnowledgeDatabase.create({ dbPath, sqliteVec: false });
    const cols = kdb.raw
      .prepare(`PRAGMA table_info(knowledge_chunk_embeddings)`)
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('bucket');

    const store = new KnowledgeSourceStore(kdb);
    const index = new KnowledgeIndexStore(kdb);
    const src = store.register({
      kind: 'directory',
      location: dir,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'mig',
    });
    await index.upsertFile({
      sourceId: src.id,
      path: join(dir, 'a.md'),
      contentHash: 'h',
      size: 1,
      mtime: Date.now(),
      adapterId: 'markdown',
      chunks: [{ ordinal: 0, text: 'x', startLine: 1, endLine: 1 }],
    });
    const cid = index.listChunksByPath(src.id, join(dir, 'a.md'))[0].id;
    // 含 bucket 的 INSERT 必须成功
    index.setChunkEmbeddings([[cid, [1, 0, 0]]]);

    kdb.close();
    await rm(dir, { recursive: true, force: true });
  });
});
