/**
 * embed_source 完成后必须能续跑（enqueue 去重不得吞掉下一棒）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';

let root: string;
let filePath: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kn-embed-cont-'));
  filePath = join(root, 'a.md');
  await writeFile(filePath, 'alpha widgets\nbeta widgets', 'utf8');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('KnowledgeIngest embed continuation', () => {
  it('embed job 标 done 后若仍缺向量则重新排队', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'embed-cont',
    });
    index.upsertFile({
      sourceId: src.id,
      path: filePath,
      contentHash: 'h',
      size: 1,
      mtime: Date.now(),
      adapterId: 'md',
      chunks: [
        { ordinal: 0, text: 'alpha widgets', startLine: 1, endLine: 1 },
        { ordinal: 1, text: 'beta widgets', startLine: 2, endLine: 2 },
      ],
    });

    let calls = 0;
    const ingest = new KnowledgeIngest({
      sourceStore: sources,
      indexStore: index,
      embedBatch: 1,
      embeddingProvider: {
        name: 'fake',
        dimensions: 2,
        async embed() {
          return [0, 1];
        },
        async embedBatch(texts: string[]) {
          calls += 1;
          // 只嵌第一条，制造「仍有 pending」
          return texts.map((_, i) => (i === 0 ? [0, 1] : []));
        },
      },
    });

    sources.database.raw
      .prepare(
        `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
         VALUES ('kj_embed1', ?, 'embed_source', NULL, 3, 'queued', 0, ?, ?)`,
      )
      .run(src.id, Date.now(), Date.now());

    // 触发 drain
    await ingest.idle(5000).catch(() => undefined);

    const jobs = sources.database.raw
      .prepare("SELECT status FROM knowledge_jobs WHERE kind = 'embed_source' ORDER BY created_at")
      .all() as Array<{ status: string }>;
    expect(calls).toBeGreaterThan(0);
    // 至少有一条 done，且若仍缺向量应出现新的 queued/running
    expect(jobs.some((j) => j.status === 'done')).toBe(true);
    const missing = index.listChunksMissingEmbedding(src.id, 10);
    if (missing.length > 0) {
      expect(jobs.some((j) => j.status === 'queued' || j.status === 'running')).toBe(true);
    }
  });
});
