/**
 * 大批量删除必须让出事件循环 — 删 800+ 文件目录不得堵死 Engine/Query 回包
 */
import { describe, expect, it } from 'vitest';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';

describe('knowledge bulk delete yields', () => {
  it('removePathTreeAsync 清子树且中途让出事件循环', async () => {
    const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
    const sources = new KnowledgeSourceStore(db);
    const index = new KnowledgeIndexStore(db);
    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-bulk',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'bulk',
    });

    const N = 300;
    for (let i = 0; i < N; i++) {
      await index.upsertFile({
        sourceId: src.id,
        path: `/tmp/kn-bulk/folder/f-${i}.md`,
        contentHash: `h${i}`,
        size: 10,
        mtime: Date.now(),
        adapterId: 'markdown',
        chunks: [{ ordinal: 0, text: `body-${i}`, startLine: 1, endLine: 1 }],
      });
    }
    await index.upsertFile({
      sourceId: src.id,
      path: `/tmp/kn-bulk/folder`,
      contentHash: 'dir',
      size: 1,
      mtime: Date.now(),
      adapterId: 'markdown',
      chunks: [{ ordinal: 0, text: 'dir', startLine: 1, endLine: 1 }],
    });

    let turns = 0;
    const ticker = setInterval(() => {
      turns += 1;
    }, 1);
    const removed = await index.removePathTreeAsync(src.id, '/tmp/kn-bulk/folder', {
      yieldEvery: 10,
    });
    clearInterval(ticker);

    expect(removed).toBe(N + 1);
    // 删除期间事件循环必须能跑 setInterval（说明中途有让出）
    expect(turns).toBeGreaterThanOrEqual(1);
    expect(index.listFiles(src.id)).toHaveLength(0);
    db.close();
  });

  it('pruneMissingAsync 批量删 gone 文件', async () => {
    const db = await KnowledgeDatabase.create({ dbPath: ':memory:' });
    const sources = new KnowledgeSourceStore(db);
    const index = new KnowledgeIndexStore(db);
    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-prune',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'prune',
    });
    for (let i = 0; i < 50; i++) {
      await index.upsertFile({
        sourceId: src.id,
        path: `/tmp/kn-prune/${i}.md`,
        contentHash: `h${i}`,
        size: 1,
        mtime: 1,
        adapterId: 'markdown',
        chunks: [{ ordinal: 0, text: 'x', startLine: 1, endLine: 1 }],
      });
    }
    const pruned = await index.pruneMissingAsync(src.id, new Set(['/tmp/kn-prune/0.md']), {
      allowEmptyKeep: true,
      yieldEvery: 5,
    });
    expect(pruned).toBe(49);
    expect(index.listFiles(src.id).map((f) => f.path)).toEqual(['/tmp/kn-prune/0.md']);
    db.close();
  });
});
