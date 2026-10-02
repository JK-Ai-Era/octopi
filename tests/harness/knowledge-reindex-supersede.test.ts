/**
 * 重建索引 = supersede：作废本源未完成任务再重扫
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kn-supersede-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'a.md'), 'hello', 'utf8');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('reindex supersede', () => {
  it('ingestSource 作废本源 queued 并标 superseded', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'sup',
    });
    sources.database.raw
      .prepare(
        `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
         VALUES ('kj_old_parse', ?, 'parse_file', ?, 2, 'queued', 0, ?, ?)`,
      )
      .run(src.id, join(root, 'docs', 'gone.md'), Date.now(), Date.now());
    sources.database.raw
      .prepare(
        `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
         VALUES ('kj_old_embed', ?, 'embed_source', NULL, 3, 'queued', 0, ?, ?)`,
      )
      .run(src.id, Date.now(), Date.now());

    const ingest = new KnowledgeIngest({
      sourceStore: sources,
      indexStore: index,
      // 不自动 kick 外的多余行为：discover 会 enqueue 新 parse
      parseConcurrency: 1,
    });

    await ingest.ingestSource(src.id);

    const old = sources.database.raw
      .prepare("SELECT status FROM knowledge_jobs WHERE id IN ('kj_old_parse','kj_old_embed')")
      .all() as Array<{ status: string }>;
    expect(old.every((j) => j.status === 'cancelled')).toBe(true);

    const err = sources.database.raw
      .prepare("SELECT last_error FROM knowledge_jobs WHERE id = 'kj_old_parse'")
      .get() as { last_error: string };
    expect(err.last_error).toBe('superseded_by_reindex');
  });
});
