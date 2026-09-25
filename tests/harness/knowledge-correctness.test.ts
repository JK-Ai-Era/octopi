/**
 * 数据正确性包 — path 防碰撞 / 差量 prune / tunables
 */
import { describe, expect, it } from 'vitest';
import { UrlFetcher } from '../../src/harness/knowledge/fetchers.js';
import { KnowledgeSourceStore } from '../../src/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '../../src/harness/knowledge/index-store.js';

describe('pathFromUrl stability', () => {
  it('separates query variants', () => {
    const a = UrlFetcher.pathFromUrl('https://ex.com/doc?page=1');
    const b = UrlFetcher.pathFromUrl('https://ex.com/doc?page=2');
    expect(a).not.toBe(b);
    expect(a.startsWith('doc')).toBe(true);
  });

  it('prefixes host when origin differs from base', () => {
    const p = UrlFetcher.pathFromUrl('https://cdn.example.com/api.html', 'https://docs.example.com/sitemap.xml');
    expect(p).toContain('cdn.example.com');
  });

  it('keeps same-origin relative path', () => {
    const p = UrlFetcher.pathFromUrl('https://docs.example.com/guide/a.html', 'https://docs.example.com/guide/');
    expect(p).toBe('a.html');
  });
});

describe('pruneMissing', () => {
  it('removes only paths not in keep set; empty keep is no-op', async () => {
    const store = await KnowledgeSourceStore.open();
    const index = new KnowledgeIndexStore(store.database);
    const src = store.register({
      kind: 'directory',
      location: '/tmp/x',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'x',
    });

    index.upsertFile({
      sourceId: src.id,
      path: 'keep.md',
      contentHash: 'h1',
      size: 1,
      mtime: 1,
      adapterId: 'markdown',
      chunks: [{ ordinal: 0, text: 'keep content here for test', startLine: 1, endLine: 1 }],
    });
    index.upsertFile({
      sourceId: src.id,
      path: 'gone.md',
      contentHash: 'h2',
      size: 1,
      mtime: 1,
      adapterId: 'markdown',
      chunks: [{ ordinal: 0, text: 'gone content here for test', startLine: 1, endLine: 1 }],
    });

    expect(index.pruneMissing(src.id, new Set<string>())).toBe(0);
    expect(index.listFiles(src.id).length).toBe(2);

    expect(index.pruneMissing(src.id, new Set(['keep.md']))).toBe(1);
    const left = index.listFiles(src.id).map((f) => f.path);
    expect(left).toEqual(['keep.md']);
    expect(index.search('gone', { sourceIds: [src.id] }).length).toBe(0);
    expect(index.search('keep', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
  });
});

describe('KnowledgeSourcePatch null clears', () => {
  it('clears description via null and re-derives displayName', async () => {
    const store = await KnowledgeSourceStore.open();
    const src = store.register({
      kind: 'file',
      location: '/data/my-docs.md',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'Custom',
      description: 'keep then clear',
    });
    const updated = store.update(src.id, { description: null, displayName: null });
    expect(updated?.description).toBeUndefined();
    expect(updated?.displayName).toBe('my-docs.md');
  });
});
