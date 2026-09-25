/**
 * 审查修复回归 — 失败不删索引 / sitemap 同源 / 跨域剥凭证 / 凭证 fail-closed 与过期
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeSourceStore } from '../../src/harness/knowledge/source-store.js';
import { KnowledgeIngest } from '../../src/harness/knowledge/ingest.js';
import { UrlFetcher } from '../../src/harness/knowledge/fetchers.js';
import { CredentialStore } from '../../src/harness/credentials/store.js';

describe('index retention on failure', () => {
  const servers: http.Server[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    delete process.env.OCTOPI_TEST_KEEP_TOKEN;
  });

  async function start(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('keeps chunks when subsequent fetch fails', async () => {
    let fail = false;
    const base = await start((_req, res) => {
      if (fail) {
        res.statusCode = 500;
        res.end('boom');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end('<html><body><p>稳定文档内容 keep-me</p></body></html>');
    });

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
      location: `${base}/doc.html`,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'keep',
      network: { allowPrivateNetwork: true },
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(10_000);
    expect(ingest.indexStore.search('keep-me', { sourceIds: [src.id] }).length).toBeGreaterThan(0);

    fail = true;
    await ingest.ingestSource(src.id);
    await ingest.idle(10_000);

    // 失败后旧 chunks 仍在
    expect(ingest.indexStore.search('keep-me', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
  });

  it('fail-closed when authRef cannot resolve', async () => {
    let hits = 0;
    const base = await start((_req, res) => {
      hits += 1;
      res.setHeader('content-type', 'text/html');
      res.end('<html><body><p>should-not-fetch</p></body></html>');
    });

    const store = await KnowledgeSourceStore.open();
    const ingest = new KnowledgeIngest({
      sourceStore: store,
      credentials: await CredentialStore.open(),
      fetchers: { url: new UrlFetcher({ allowPrivateNetwork: true }) },
    });
    cleanups.push(async () => {
      ingest.dispose();
      store.database.close();
    });

    const src = store.register({
      kind: 'url',
      location: `${base}/p.html`,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'need-auth',
      authRef: 'missing-cred',
      network: { allowPrivateNetwork: true },
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(5_000);
    expect(hits).toBe(0);
    expect(ingest.indexStore.sourceStats(src.id).chunks).toBe(0);
    expect(store.get(src.id)?.status).toBe('error');
  });

  it('rejects expired credentials', async () => {
    process.env.OCTOPI_TEST_KEEP_TOKEN = 'tok-exp';
    const creds = await CredentialStore.open();
    creds.set({
      name: 'expired',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: 'OCTOPI_TEST_KEEP_TOKEN',
      expiresAt: Date.now() - 1000,
    });
    expect(await creds.resolve('expired')).toBeNull();
    expect(await creds.resolve('expired')).toBeNull();
  });
});

describe('credential leak guards', () => {
  const servers: http.Server[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });

  it('sitemap ignores cross-origin locs', async () => {
    const evilHits: string[] = [];
    const evil = http.createServer((req, res) => {
      evilHits.push(req.url ?? '');
      res.end('<html><body><p>evil</p></body></html>');
    });
    servers.push(evil);
    await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
    const evilBase = `http://127.0.0.1:${(evil.address() as AddressInfo).port}`;

    // sitemap 与文档同 host；evil 在另一端口 = 另一 origin
    const good = http.createServer((req, res) => {
      const path = req.url ?? '';
      if (path === '/sitemap.xml') {
        res.setHeader('content-type', 'application/xml');
        res.end(`<?xml version="1.0"?><urlset>
          <url><loc>${evilBase}/steal.html</loc></url>
        </urlset>`);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    servers.push(good);
    await new Promise<void>((r) => good.listen(0, '127.0.0.1', r));
    const goodBase = `http://127.0.0.1:${(good.address() as AddressInfo).port}`;

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
      location: `${goodBase}/sitemap.xml`,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'sm',
      network: { allowPrivateNetwork: true },
      discover: { mode: 'sitemap' },
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(10_000);
    expect(evilHits).toEqual([]);
    expect(ingest.indexStore.listFiles(src.id).length).toBe(0);
  });

  it('strips Authorization on cross-origin redirect', async () => {
    let evilAuth: string | undefined;
    const evil = http.createServer((req, res) => {
      evilAuth = req.headers.authorization;
      res.setHeader('content-type', 'text/html');
      res.end('<html><body><p>redirected</p></body></html>');
    });
    servers.push(evil);
    await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
    const evilBase = `http://127.0.0.1:${(evil.address() as AddressInfo).port}`;

    const good = http.createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', `${evilBase}/x.html`);
      res.end();
    });
    servers.push(good);
    await new Promise<void>((r) => good.listen(0, '127.0.0.1', r));
    const goodBase = `http://127.0.0.1:${(good.address() as AddressInfo).port}`;

    const fetcher = new UrlFetcher({ allowPrivateNetwork: true, maxRedirects: 5 });
    const { guardedFetch } = await import('../../src/harness/knowledge/network-guard.js');
    await guardedFetch(
      `${goodBase}/start`,
      { allowPrivateNetwork: true },
      { headers: { Authorization: 'Bearer SECRET-TOKEN' } },
    );

    expect(evilAuth).toBeUndefined();
  });
});
