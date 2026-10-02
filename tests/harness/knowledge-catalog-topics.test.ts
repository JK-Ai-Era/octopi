/**
 * Catalog topics 派生 + knowledge_search 源过滤
 */
import { describe, it, expect } from 'vitest';
import { deriveTopicsFromPaths } from '@octopi-agent/engine/harness/knowledge/topics.js';
import { KnowledgeRetriever } from '@octopi-agent/engine/harness/knowledge/retriever.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';

describe('deriveTopicsFromPaths', () => {
  it('从目录/文件名抽出稳定短词，过滤停用词', () => {
    const topics = deriveTopicsFromPaths([
      '/data/docs/architecture.md',
      '/data/docs/knowledge-layer.md',
      '/data/src/gateway/protocol.ts',
      '/data/tests/gateway.test.ts',
    ]);
    expect(topics).toContain('docs');
    expect(topics).toContain('architecture');
    expect(topics).toContain('gateway');
    expect(topics).not.toContain('src');
    expect(topics).not.toContain('tests');
  });

  it('空路径返回空列表', () => {
    expect(deriveTopicsFromPaths([])).toEqual([]);
  });
});

describe('KnowledgeRetriever source filter', () => {
  it('source_id 与可见集求交，不可越权', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const a = sources.register({
      kind: 'directory',
      location: '/tmp/kn-a',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'alpha',
    });
    sources.register({
      kind: 'directory',
      location: '/tmp/kn-b',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'beta',
    });

    index.upsertFile({
      sourceId: a.id,
      path: '/tmp/kn-a/doc.md',
      contentHash: 'h1',
      size: 10,
      mtime: Date.now(),
      adapterId: 'md',
      chunks: [
        {
          ordinal: 0,
          text: 'alpha knowledge about widgets',
          startLine: 1,
          endLine: 1,
        },
      ],
    });

    const retriever = new KnowledgeRetriever({
      sourceStore: sources,
      indexStore: index,
    });

    const filtered = await retriever.search('widgets', {
      agentId: 'default',
      sourceIds: [a.id],
    });
    expect(filtered.hits.length).toBeGreaterThan(0);
    expect(filtered.hits.every((h) => h.sourceId === a.id)).toBe(true);

    const byName = await retriever.search('widgets', {
      agentId: 'default',
      source: 'beta',
    });
    expect(byName.hits).toEqual([]);

    const missing = await retriever.search('widgets', {
      agentId: 'default',
      sourceIds: ['ks_does_not_exist'],
    });
    expect(missing.hits).toEqual([]);
  });
});
