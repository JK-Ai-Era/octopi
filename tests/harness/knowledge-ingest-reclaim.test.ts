/**
 * KnowledgeIngest 启动回收孤儿 running 任务
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';

describe('KnowledgeIngest reclaim orphan running jobs', () => {
  it('构造时把历史 running 收回 queued', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const src = sources.register({
      kind: 'directory',
      location: '/tmp/kn-orphan',
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'orphan',
    });
    sources.database.raw
      .prepare(
        `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
         VALUES ('kj_orphan', ?, 'embed_source', NULL, 3, 'running', 0, ?, ?)`,
      )
      .run(src.id, Date.now(), Date.now());

    new KnowledgeIngest({ sourceStore: sources, indexStore: new KnowledgeIndexStore(sources.database) });

    const row = sources.database.raw
      .prepare("SELECT status FROM knowledge_jobs WHERE id = 'kj_orphan'")
      .get() as { status: string };
    expect(row.status).toBe('queued');
  });
});
