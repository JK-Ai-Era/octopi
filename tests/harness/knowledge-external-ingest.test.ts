/**
 * Knowledge 外源 ingest U1 — HTML 规范化 / 网络门禁 / URL 单页索引
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { htmlToStructuredText, looksLikeHtml } from '../../src/harness/knowledge/html.js';
import { assertUrlAllowed, isRestrictedIp } from '../../src/harness/knowledge/network-guard.js';
import { UrlFetcher } from '../../src/harness/knowledge/fetchers.js';
import { KnowledgeSourceStore } from '../../src/harness/knowledge/source-store.js';
import { KnowledgeIngest } from '../../src/harness/knowledge/ingest.js';
import { CredentialStore } from '../../src/harness/credentials/store.js';

function makeHtml(): string {
  return `<!doctype html>
<html><head><title>鉴权指南</title>
<script>var x=1;</script><style>.a{}</style></head>
<body>
<nav>Home Docs API</nav>
<main>
  <h1>鉴权指南</h1>
  <p>使用 JWT 完成会话鉴权。</p>
  <h2>步骤</h2>
  <p>先申请客户端凭证，再换取访问令牌。</p>
  <ul><li>申请凭证</li><li>换取令牌</li></ul>
</main>
<footer>copyright</footer>
</body></html>`;
}

describe('htmlToStructuredText', () => {
  it('extracts title and headings, drops script/nav/footer', () => {
    const text = htmlToStructuredText(makeHtml());
    expect(text).toContain('# 鉴权指南');
    expect(text).toContain('## 步骤');
    expect(text).toContain('使用 JWT 完成会话鉴权');
    expect(text).not.toContain('var x=1');
    expect(text).not.toContain('<nav>');
    expect(text).not.toContain('copyright');
  });

  it('detects html by content-type or sniff', () => {
    expect(looksLikeHtml('<html></html>', 'text/html; charset=utf-8')).toBe(true);
    expect(looksLikeHtml('<!DOCTYPE html><html>', undefined)).toBe(true);
    expect(looksLikeHtml('plain text', undefined)).toBe(false);
  });
});

describe('network guard', () => {
  it('flags restricted IPs', () => {
    expect(isRestrictedIp('127.0.0.1')).toBe(true);
    expect(isRestrictedIp('10.0.0.5')).toBe(true);
    expect(isRestrictedIp('192.168.1.1')).toBe(true);
    expect(isRestrictedIp('169.254.169.254')).toBe(true);
    expect(isRestrictedIp('8.8.8.8')).toBe(false);
  });

  it('rejects private url by default and allows with flag', async () => {
    await expect(assertUrlAllowed('http://127.0.0.1/x')).rejects.toThrow(/not allowed/);
    await expect(
      assertUrlAllowed('http://127.0.0.1/x', { allowPrivateNetwork: true }),
    ).resolves.toBeTruthy();
  });

  it('rejects non-http protocol', async () => {
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toThrow(/protocol/);
  });
});

describe('UrlFetcher path derivation', () => {
  it('uses stable logical path not full url', () => {
    expect(UrlFetcher.pathFromUrl('https://docs.example.com/api/auth.html')).toBe('api/auth.html');
    expect(UrlFetcher.pathFromUrl('https://docs.example.com/')).toBe('index');
    // query 参与 path（防 ?a/?b 折叠），但不是完整 URL
    const withQuery = UrlFetcher.pathFromUrl('https://docs.example.com/api/?utm=1');
    expect(withQuery.startsWith('api~')).toBe(true);
    expect(withQuery).not.toContain('https:');
  });
});

describe('url source ingest (local http server)', () => {
  const servers: http.Server[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    delete process.env.OCTOPI_TEST_URL_TOKEN;
  });

  async function startServer(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  it('indexes single url with html normalize and cjk search', async () => {
    const base = await startServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(makeHtml());
    });

    const store = await KnowledgeSourceStore.open();
    const ingest = new KnowledgeIngest({
      sourceStore: store,
      parseConcurrency: 2,
      fetchers: {
        url: new UrlFetcher({ allowPrivateNetwork: true }),
      },
    });
    cleanups.push(async () => {
      ingest.dispose();
    });

    const src = store.register({
      kind: 'url',
      location: `${base}/guide/auth.html`,
      scopeRef: { level: 'global', key: 'global' },
      sync: { strategy: 'manual', enabled: true },
      displayName: 'auth-guide',
      network: { allowPrivateNetwork: true },
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(10_000);

    const hitsZh = ingest.indexStore.search('会话鉴权', { sourceIds: [src.id] });
    expect(hitsZh.length).toBeGreaterThan(0);
    expect(hitsZh[0].path).toBe('guide/auth.html');
    expect(hitsZh[0].text).not.toContain('<div');

    const file = ingest.indexStore.getFile(src.id, 'guide/auth.html');
    expect(file?.externalUrl).toContain('/guide/auth.html');
    expect(file?.status).toBe('indexed');

    // 幂等：同 content-hash 不重复劳动
    await ingest.ingestSource(src.id);
    await ingest.idle(10_000);
    expect(ingest.indexStore.search('JWT', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
  });

  it('skips non-text content', async () => {
    const base = await startServer((_req, res) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(Buffer.from([0, 1, 2, 3]));
    });

    const store = await KnowledgeSourceStore.open();
    const ingest = new KnowledgeIngest({
      sourceStore: store,
      fetchers: { url: new UrlFetcher({ allowPrivateNetwork: true }) },
    });
    cleanups.push(async () => {
      ingest.dispose();
    });

    const src = store.register({
      kind: 'url',
      location: `${base}/blob.bin`,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'blob',
      network: { allowPrivateNetwork: true },
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(10_000);
    const stats = ingest.indexStore.sourceStats(src.id);
    expect(stats.chunks).toBe(0);
  });

  it('injects auth headers from CredentialStore', async () => {
    let sawAuth: string | undefined;
    const base = await startServer((req, res) => {
      sawAuth = req.headers.authorization;
      res.setHeader('content-type', 'text/html');
      res.end('<html><body><p>需要鉴权的文档内容 secret-body</p></body></html>');
    });

    process.env.OCTOPI_TEST_URL_TOKEN = 'tok-123';
    const creds = await CredentialStore.open();
    creds.set({
      name: 'local-demo',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: 'OCTOPI_TEST_URL_TOKEN',
    });

    const store = await KnowledgeSourceStore.open();
    const ingest = new KnowledgeIngest({
      sourceStore: store,
      credentials: creds,
      fetchers: { url: new UrlFetcher({ allowPrivateNetwork: true }) },
    });
    cleanups.push(async () => {
      ingest.dispose();
    });

    const src = store.register({
      kind: 'url',
      location: `${base}/private.html`,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'private',
      authRef: 'local-demo',
      network: { allowPrivateNetwork: true },
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(10_000);

    expect(sawAuth).toBe('Bearer tok-123');
    expect(ingest.indexStore.search('鉴权的文档', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
  });
});
