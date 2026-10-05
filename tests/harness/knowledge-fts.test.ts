/**
 * FTS5 倒排：中文二元组可搜、与 LIKE 回退一致、增量同步
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import {
  KnowledgeFts,
  buildFtsQuery,
  buildFtsTokens,
} from '@octopi-agent/engine/harness/knowledge/fts.js';

describe('knowledge FTS5', () => {
  it('buildFtsTokens 含 CJK 二元组；buildFtsQuery 为 OR', () => {
    const toks = buildFtsTokens('使用 JWT 做会话鉴权', 'docs/auth-guide.md');
    expect(toks).toContain('jwt');
    expect(toks).toContain('鉴权');
    expect(toks).toContain('会话');
    expect(toks).toContain('auth');
    const q = buildFtsQuery('鉴权设计');
    expect(q).toContain('"鉴权"');
    expect(q.toUpperCase()).toContain('OR');
  });

  it('FTS 可搜中文与路径，增量 upsert/remove 生效', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-fts',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'fts',
    });

    index.upsertFile({
      sourceId: src.id,
      path: '/tmp/kn-fts/auth.md',
      contentHash: 'h1',
      size: 10,
      mtime: Date.now(),
      adapterId: 'markdown',
      chunks: [
        { ordinal: 0, text: '使用 JWT 完成会话鉴权', startLine: 1, endLine: 1 },
        { ordinal: 1, text: 'rate limit 限流策略', startLine: 2, endLine: 2 },
      ],
    });

    const hits1 = index.search('会话鉴权', { sourceIds: [src.id] });
    expect(hits1.length).toBeGreaterThan(0);
    expect(hits1[0].text).toContain('鉴权');

    const hits2 = index.search('限流', { sourceIds: [src.id] });
    expect(hits2.length).toBeGreaterThan(0);

    const hitsPath = index.search('auth', { sourceIds: [src.id] });
    expect(hitsPath.length).toBeGreaterThan(0);

    // 删除后不可再命中
    index.removeFile(src.id, '/tmp/kn-fts/auth.md');
    const after = index.search('会话鉴权', { sourceIds: [src.id] });
    expect(after.length).toBe(0);
    sources.database.close();
  });

  it('FTS 可用时 search 不依赖 LIKE 截断；源过滤生效', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const fts = new KnowledgeFts(sources.database);
    expect(fts.available).toBe(true);

    const a = sources.register({
      kind: 'directory',
      location: '/tmp/kn-fts-a',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'a',
    });
    const b = sources.register({
      kind: 'directory',
      location: '/tmp/kn-fts-b',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'b',
    });
    index.upsertFile({
      sourceId: a.id,
      path: '/tmp/kn-fts-a/doc.md',
      contentHash: 'h',
      size: 1,
      mtime: Date.now(),
      adapterId: 'markdown',
      chunks: [{ ordinal: 0, text: '独特的关键字甲', startLine: 1, endLine: 1 }],
    });
    index.upsertFile({
      sourceId: b.id,
      path: '/tmp/kn-fts-b/doc.md',
      contentHash: 'h',
      size: 1,
      mtime: Date.now(),
      adapterId: 'markdown',
      chunks: [{ ordinal: 0, text: '独特的关键字乙', startLine: 1, endLine: 1 }],
    });

    const onlyA = index.search('关键字甲', { sourceIds: [a.id] });
    expect(onlyA.length).toBeGreaterThan(0);
    expect(onlyA.every((h) => h.sourceId === a.id)).toBe(true);

    const both = index.search('独特的', { sourceIds: [a.id, b.id] });
    expect(both.length).toBeGreaterThanOrEqual(2);
    sources.database.close();
  });

  it('rebuildFromChunks 可整库重跑（Index 非权威）', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const fts = new KnowledgeFts(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-fts-rb',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'rb',
    });
    index.upsertFile({
      sourceId: src.id,
      path: '/tmp/kn-fts-rb/x.md',
      contentHash: 'h',
      size: 1,
      mtime: Date.now(),
      adapterId: 'markdown',
      chunks: [{ ordinal: 0, text: '重建索引测试', startLine: 1, endLine: 1 }],
    });
    sources.database.raw.exec('DELETE FROM knowledge_chunks_fts');
    expect(index.search('重建索引', { sourceIds: [src.id] }).length).toBeGreaterThan(0); // 退 LIKE 仍可搜
    const n = fts.rebuildFromChunks();
    expect(n).toBeGreaterThan(0);
    expect(index.search('重建索引', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
    sources.database.close();
  });
});
