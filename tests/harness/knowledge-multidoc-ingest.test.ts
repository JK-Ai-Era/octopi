/**
 * U3 — sitemap / 同域有限 crawl 多页发现
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { UrlFetcher } from '../../src/harness/knowledge/fetchers.js';
import { KnowledgeSourceStore } from '../../src/harness/knowledge/source-store.js';
import { KnowledgeIngest } from '../../src/harness/knowledge/ingest.js';

const serverPages = new Map<string, string>();

function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const body = serverPages.get(path);
  if (!body) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  res.setHeader('content-type', path.endsWith('.xml') ? 'application/xml' : 'text/html; charset=utf-8');
  res.end(body);
}

describe('UrlFetcher sitemap/crawl helpers', () => {
  it('parses sitemap locs', () => {
    const xml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://ex.com/a.html</loc></url>
        <url><loc>https://ex.com/b.html</loc></url>
      </urlset>`;
    expect(UrlFetcher.parseSitemapLocs(xml)).toEqual(['https://ex.com/a.html', 'https://ex.com/b.html']);
  });

  it('extracts same-origin links only', () => {
    const html = `<a href="/one">1</a><a href="https://ex.com/two">2</a>
      <a href="https://other.com/x">x</a><a href="mailto:a@b.c">m</a>`;
    const links = UrlFetcher.extractLinks(html, 'https://ex.com/start');
    expect(links).toContain('https://ex.com/one');
    expect(links).toContain('https://ex.com/two');
    expect(links.some((l) => l.includes('other.com'))).toBe(false);
    expect(links.some((l) => l.startsWith('mailto:'))).toBe(false);
  });
});

describe('multi-page ingest', () => {
  const servers: http.Server[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    serverPages.clear();
  });

  async function start(): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('discovers docs from sitemap.xml', async () => {
    const base = await start();
    serverPages.set(
      '/sitemap.xml',
      `<?xml version="1.0"?><urlset>
        <url><loc>${base}/guide/auth.html</loc></url>
        <url><loc>${base}/guide/setup.html</loc></url>
      </urlset>`,
    );
    serverPages.set(
      '/guide/auth.html',
      '<html><head><title>鉴权</title></head><body><h1>鉴权</h1><p>JWT 会话鉴权说明</p></body></html>',
    );
    serverPages.set(
      '/guide/setup.html',
      '<html><head><title>安装</title></head><body><h1>安装</h1><p>初始化工作目录</p></body></html>',
    );

    const store = await KnowledgeSourceStore.open();
    const ingest = new KnowledgeIngest({
      sourceStore: store,
      fetchers: { url: new UrlFetcher({ allowPrivateNetwork: true }) },
    });
    cleanups.push(async () => {
      ingest.dispose();
      store.database.close();
    });

    const src = store.register({
      kind: 'url',
      location: `${base}/sitemap.xml`,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'docs-sitemap',
      network: { allowPrivateNetwork: true },
      discover: { mode: 'sitemap', maxPages: 10 },
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(15_000);

    expect(ingest.indexStore.search('会话鉴权', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
    expect(ingest.indexStore.search('工作目录', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
    const files = ingest.indexStore.listFiles(src.id).map((f) => f.path);
    expect(files.some((p) => p.includes('auth'))).toBe(true);
    expect(files.some((p) => p.includes('setup'))).toBe(true);
  });

  it('crawls same-origin within depth/page budget', async () => {
    const base = await start();
    serverPages.set(
      '/',
      '<html><body><p>首页入口</p><a href="/a.html">A</a><a href="https://evil.example/x">ext</a></body></html>',
    );
    serverPages.set(
      '/a.html',
      '<html><body><h2>子页 A</h2><p>关于限流的文档</p><a href="/b.html">B</a></body></html>',
    );
    serverPages.set(
      '/b.html',
      '<html><body><h2>子页 B</h2><p>重试策略说明</p></body></html>',
    );

    const store = await KnowledgeSourceStore.open();
    const ingest = new KnowledgeIngest({
      sourceStore: store,
      fetchers: { url: new UrlFetcher({ allowPrivateNetwork: true }) },
    });
    cleanups.push(async () => {
      ingest.dispose();
      store.database.close();
    });

    const src = store.register({
      kind: 'url',
      location: `${base}/`,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'crawl-root',
      network: { allowPrivateNetwork: true },
      discover: { mode: 'crawl', maxPages: 5, maxDepth: 2 },
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(15_000);

    expect(ingest.indexStore.search('限流', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
    expect(ingest.indexStore.search('重试', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
    // 外域链接不入
    const urls = ingest.indexStore
      .listFiles(src.id)
      .map((f) => f.externalUrl ?? '');
    expect(urls.every((u) => u.startsWith(base))).toBe(true);
  });

  it('respects maxPages budget', async () => {
    const base = await start();
    serverPages.set(
      '/',
      '<html><body>' +
        Array.from({ length: 8 }, (_, i) => `<a href="/p${i}.html">p${i}</a>`).join('') +
        '</body></html>',
    );
    for (let i = 0; i < 8; i++) {
      serverPages.set(`/p${i}.html`, `<html><body><p>页面内容 ${i} unique-${i}</p></body></html>`);
    }

    const store = await KnowledgeSourceStore.open();
    const ingest = new KnowledgeIngest({
      sourceStore: store,
      fetchers: { url: new UrlFetcher({ allowPrivateNetwork: true }) },
    });
    cleanups.push(async () => {
      ingest.dispose();
      store.database.close();
    });

    const src = store.register({
      kind: 'url',
      location: `${base}/`,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'budget',
      network: { allowPrivateNetwork: true },
      discover: { mode: 'crawl', maxPages: 3, maxDepth: 1 },
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(15_000);
    const files = ingest.indexStore.listFiles(src.id);
    expect(files.length).toBeLessThanOrEqual(3);
  });
});
