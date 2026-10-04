/**
 * 源文件分页 / 筛选
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';

describe('KnowledgeIndexStore.listFilesPaged', () => {
  async function seed() {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-page',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'page',
    });
    for (let i = 0; i < 5; i++) {
      index.upsertFile({
        sourceId: src.id,
        path: `/tmp/kn-page/a${i}.md`,
        contentHash: `h${i}`,
        size: 10 + i,
        mtime: Date.now(),
        adapterId: 'md',
        chunks: [{ ordinal: 0, text: `t${i}`, startLine: 1, endLine: 1 }],
      });
    }
    index.markFileSkipped(src.id, '/tmp/kn-page/big.pptx', 'oversize_soft', 80_000_000);
    index.markFileSkipped(src.id, '/tmp/kn-page/skip.pptx', 'no_adapter', 1);
    index.markFileError(src.id, '/tmp/kn-page/bad.pdf', 'extract failed', 2);
    return { index, src };
  }

  it('pages and filters by status and ext', async () => {
    const { index, src } = await seed();

    const all = index.listFilesPaged(src.id, { page: 1, pageSize: 3 });
    expect(all.total).toBe(8);
    expect(all.items).toHaveLength(3);
    expect(all.statusCounts).toEqual({ indexed: 5, skipped: 2, error: 1 });
    expect(all.extCounts.some((e) => e.ext === 'md' && e.n === 5)).toBe(true);
    expect(all.extCounts.some((e) => e.ext === 'pptx' && e.n === 2)).toBe(true);

    const skipped = index.listFilesPaged(src.id, { status: 'skipped', pageSize: 50 });
    expect(skipped.total).toBe(2);
    expect(skipped.items.every((f) => f.status === 'skipped')).toBe(true);

    const pptx = index.listFilesPaged(src.id, { ext: 'pptx', pageSize: 50 });
    expect(pptx.total).toBe(2);
    expect(pptx.items.every((f) => f.ext === 'pptx')).toBe(true);

    const q = index.listFilesPaged(src.id, { q: 'bad', pageSize: 50 });
    expect(q.total).toBe(1);
    expect(q.items[0]?.path).toContain('bad');
  });
});
