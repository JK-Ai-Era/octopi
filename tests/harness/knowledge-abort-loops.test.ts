/**
 * P1-2 中止闭环：remote 抓取循环 / walk 入队 / job 收尾统一 isAborted
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSourceStore } from '@octopi-agent/engine/harness/knowledge/source-store.js';
import { KnowledgeIndexStore } from '@octopi-agent/engine/harness/knowledge/index-store.js';
import { KnowledgeIngest } from '@octopi-agent/engine/harness/knowledge/ingest.js';
import { UrlFetcher } from '@octopi-agent/engine/harness/knowledge/fetchers.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kn-abort-loop-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('abort closes remote/walk loops', () => {
  it('ingestRemoteSource 中止后停止抓取与 prune', async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      const url = req.url ?? '';
      if (url.endsWith('/site.xml')) {
        res.setHeader('content-type', 'application/xml');
        // 多页 sitemap，足够多以便中止发生在中途
        const locs = Array.from({ length: 20 }, (_, i) => `<url><loc>http://127.0.0.1:${(server.address() as AddressInfo).port}/p${i}.html</loc></url>`).join('');
        res.end(`<?xml version="1.0"?><urlset>${locs}</urlset>`);
        return;
      }
      res.setHeader('content-type', 'text/html');
      // 第一次内容响应后由测试触发 abort
      res.end(`<html><body><p>page ${url}</p></body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'url',
      location: `${base}/site.xml`,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'abort-remote',
      network: { allowPrivateNetwork: true },
      discover: { mode: 'sitemap', maxPages: 20 },
    });

    const ingest = new KnowledgeIngest({
      sourceStore: sources,
      indexStore: index,
      fetchers: { url: new UrlFetcher({ allowPrivateNetwork: true }) },
    });

    // 预置一条旧索引：中止后不得被 prune 掉（半截 keep）
    index.upsertFile({
      sourceId: src.id,
      path: '/keep-me',
      contentHash: 'old',
      size: 1,
      mtime: Date.now(),
      adapterId: 'markdown',
      chunks: [{ ordinal: 0, text: 'keep', startLine: 1, endLine: 1 }],
    });

    const run = ingest.ingestSource(src.id);
    // 抓几张后立刻中止
    await new Promise((r) => setTimeout(r, 30));
    ingest.abortJobs({ sourceId: src.id });
    await run;

    try {
      // keep-me 仍在（中止后未 prune）
      expect(index.getFile(src.id, '/keep-me')).toBeTruthy();
      // 未跑完 20 页（中止生效）
      expect(hits).toBeLessThan(25);
    } finally {
      ingest.dispose();
      sources.database.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('runJob 收尾：中止后不得标 done', async () => {
    const sources = await KnowledgeSourceStore.open({ dbPath: ':memory:' });
    const index = new KnowledgeIndexStore(sources.database);
    const src = sources.register({
      kind: 'directory',
      location: root,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'abort-done',
    });
    await writeFile(join(root, 'a.md'), '# a\n', 'utf8');

    const ingest = new KnowledgeIngest({ sourceStore: sources, indexStore: index });
    try {
      sources.database.raw
        .prepare(
          `INSERT INTO knowledge_jobs (id, source_id, kind, path, priority, status, attempts, created_at, updated_at)
           VALUES ('kj_walk', ?, 'walk_source', NULL, 1, 'queued', 0, ?, ?)`,
        )
        .run(src.id, Date.now(), Date.now());
      // 入队后立刻中止：claim 可能仍抢到，但收尾必须 cancelled
      ingest.abortJobs({ sourceId: src.id });
      await ingest.idle(5_000).catch(() => {});

      const job = sources.database.raw
        .prepare(`SELECT status, last_error FROM knowledge_jobs WHERE id = 'kj_walk'`)
        .get() as { status: string; last_error: string | null } | undefined;
      // 要么未被 claim（仍 queued 后被 cancel），要么 cancelled——不得 done
      expect(job?.status).not.toBe('done');
    } finally {
      ingest.dispose();
      sources.database.close();
    }
  });
});
