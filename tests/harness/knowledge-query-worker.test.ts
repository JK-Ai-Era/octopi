/**
 * Query Worker — 只读查询与 ingest 写路径线程隔离
 *
 * 回归：search/list 在写库高峰仍可应答；hash 不在 Engine 整文件读入。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { KnowledgeDatabase } from '@octopi-agent/engine/harness/knowledge/db.js';
import { createKnowledgeQueryService } from '@octopi-agent/engine/harness/knowledge/query-service.js';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeRetriever } from '@octopi-agent/engine/harness/knowledge/retriever.js';
import { extractDocumentInWorker } from '@octopi-agent/engine/harness/knowledge/extract-document.js';
import { hashFileStreaming } from '@octopi-agent/engine/harness/knowledge/ingest.js';

describe('knowledge query worker isolation', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kn-query-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('WorkerQueryService 与 Local 结果一致（search / stats / list）', async () => {
    const dbPath = join(dir, 'q.db');
    const corpus = join(dir, 'corpus');
    await mkdir(corpus, { recursive: true });
    await writeFile(join(corpus, 'a.md'), '# alpha\n\nunique-query-token-xyz\n', 'utf8');

    const db = await KnowledgeDatabase.create({ dbPath });
    const sources = new KnowledgeSourceStore(db);
    const index = new KnowledgeIndexStore(db);
    const retriever = new KnowledgeRetriever({ sourceStore: sources, indexStore: index });
    const local = await createKnowledgeQueryService({
      dbPath,
      mode: 'local',
      local: { db, sources, index, retriever },
    });

    sources.register({
      kind: 'directory',
      location: corpus,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'corpus',
    });
    const src = sources.list()[0]!;
    await index.upsertFile({
      sourceId: src.id,
      path: join(corpus, 'a.md'),
      contentHash: 'h1',
      size: 10,
      mtime: Date.now(),
      adapterId: 'markdown',
      chunks: [
        {
          ordinal: 0,
          text: 'unique-query-token-xyz',
          startLine: 1,
          endLine: 1,
        },
      ],
    });

    const worker = await createKnowledgeQueryService({
      dbPath,
      mode: 'worker',
    });
    try {
      const localHits = await local.search({
        agentId: 'agent-1',
        q: 'unique-query-token-xyz',
        limit: 5,
      });
      const workerHits = await worker.search({
        agentId: 'agent-1',
        q: 'unique-query-token-xyz',
        limit: 5,
      });
      expect(workerHits.hits.length).toBeGreaterThan(0);
      expect(workerHits.hits.length).toBe(localHits.hits.length);
      expect(workerHits.hits[0]?.text).toContain('unique-query-token-xyz');

      const localStats = await local.principalStats('agent-1');
      const workerStats = await worker.principalStats('agent-1');
      expect(workerStats.stats.chunks).toBe(localStats.stats.chunks);
      expect(workerStats.visibleSources).toBe(localStats.visibleSources);

      const workerList = await worker.listSources({ scopeLevel: 'global' });
      expect(workerList.some((s) => s.displayName === 'corpus')).toBe(true);
    } finally {
      await worker.dispose();
      db.close();
    }
  });

  it('hashFileStreaming 与整文件 SHA-256 一致；extract worker 返回 contentHash', async () => {
    const p = join(dir, 'note.txt');
    const body = Buffer.from('hello knowledge hash\n'.repeat(50));
    await writeFile(p, body);
    const expectHash = createHash('sha256').update(body).digest('hex');
    expect(await hashFileStreaming(p)).toBe(expectHash);

    // DocumentPort 文本后端可抽纯文本；contentHash 必须由 worker 流式给出
    const extracted = await extractDocumentInWorker(p, { timeoutMs: 10_000 });
    expect(extracted.contentHash).toBe(expectHash);
  });
});
