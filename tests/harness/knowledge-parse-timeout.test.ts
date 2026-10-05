/**
 * parse 超时必须真正取消 — 禁止僵尸 upsert 覆盖 / 双跑
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';

// 让 extractDocument 走 documentPort 回退：worker 路径不可用
vi.mock('@octopi-agent/engine/harness/knowledge/extract-document.js', () => ({
  extractDocumentInWorker: () => {
    const err = new Error('Cannot find module document-extract-worker');
    return Promise.reject(err);
  },
}));

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kn-timeout-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('parse timeout cancels work', () => {
  it('超时后 DocumentPort 被 abort，且不得 upsert 僵尸结果', async () => {
    let extractStarted = false;
    let extractSawAbort = false;
    let extractResolvedAfterAbort = false;

    const slowPort = {
      async extract(
        _src: unknown,
        opts?: { signal?: AbortSignal },
      ): Promise<{
        markdown: string;
        meta: { format: string };
        warnings: unknown[];
        backend: string;
      }> {
        extractStarted = true;
        const signal = opts?.signal;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 2_000);
          signal?.addEventListener(
            'abort',
            () => {
              extractSawAbort = true;
              clearTimeout(timer);
              reject(new Error('extract_aborted'));
            },
            { once: true },
          );
        });
        extractResolvedAfterAbort = true;
        return {
          markdown: '# should not land\n\nzombie body',
          meta: { format: 'pdf' },
          warnings: [],
          backend: 'slow-stub',
        };
      },
    };

    const filePath = join(root, 'big.pdf');
    await writeFile(filePath, '%PDF-1.4 fake', 'utf8');

    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'timeout',
    });

    const ingest = new KnowledgeIngest({
      sourceStore: sources,
      indexStore: index,
      documentPort: slowPort as never,
      parseTimeoutMs: 80,
      fileLimits: { parseTimeoutMs: 80, maxParseTimeoutMs: 80 },
    });

    try {
      await ingest.reprocessFiles(src.id, [filePath]);
      await ingest.idle(5_000);

      expect(extractStarted).toBe(true);
      expect(extractSawAbort).toBe(true);
      expect(extractResolvedAfterAbort).toBe(false);

      const chunks = index.listChunksByPath(src.id, filePath);
      expect(chunks.length).toBe(0);
      const file = index.getFile(src.id, filePath);
      if (file && file.status === 'indexed') {
        expect(file.chunkCount).toBe(0);
      }

      const job = sources.database.raw
        .prepare(
          `SELECT status, last_error FROM knowledge_jobs
           WHERE source_id = ? AND path = ? AND kind = 'parse_file'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(src.id, filePath) as { status: string; last_error: string | null } | undefined;
      expect(job?.status).toBe('failed');
      expect(job?.last_error).toMatch(/parse_timeout/);
    } finally {
      ingest.dispose();
      sources.database.close();
    }
  });

  it('stale 回收阈值必须大于硬超时（防合法长 parse 被收回双跑）', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'stale',
    });
    const ingest = new KnowledgeIngest({
      sourceStore: sources,
      indexStore: index,
      fileLimits: { maxParseTimeoutMs: 120_000 },
    });
    try {
      const now = Date.now();
      sources.database.raw
        .prepare(
          `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
           VALUES ('kj_live', ?, 'parse_file', ?, 1, 'running', 0, ?, ?)`,
        )
        .run(src.id, join(root, 'a.md'), now, now);
      await ingest.reconcileJobs();
      const row = sources.database.raw
        .prepare(`SELECT status FROM knowledge_jobs WHERE id = 'kj_live'`)
        .get() as { status: string };
      expect(row.status).toBe('running');
    } finally {
      ingest.dispose();
      sources.database.close();
    }
  });
});
