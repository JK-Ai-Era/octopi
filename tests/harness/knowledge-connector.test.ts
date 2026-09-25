/**
 * U4 — RestConnector / ConnectorFetcher / http_request.credential
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeSourceStore } from '../../src/harness/knowledge/source-store.js';
import { KnowledgeIngest } from '../../src/harness/knowledge/ingest.js';
import { RestConnector, ConnectorRegistry } from '../../src/harness/knowledge/connectors.js';
import { CredentialStore } from '../../src/harness/credentials/store.js';
import { createHttpRequestTool } from '../../src/harness/plugin-ecosystem/tools/http.js';

describe('RestConnector', () => {
  const servers: http.Server[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });

  async function start(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('ingests docs from REST list with contentField', async () => {
    const base = await start((req, res) => {
      if (req.headers.authorization !== 'Bearer tok-rest') {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          results: [
            { id: 'auth-guide', title: '鉴权', body: '<h1>鉴权</h1><p>使用 API Key 访问文档库</p>' },
            { id: 'rate-limit', title: '限流', body: '每分钟最多 60 次请求' },
          ],
        }),
      );
    });

    process.env.OCTOPI_TEST_REST_TOKEN = 'tok-rest';
    const creds = await CredentialStore.open();
    creds.set({
      name: 'rest-demo',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: 'OCTOPI_TEST_REST_TOKEN',
    });

    const store = await KnowledgeSourceStore.open();
    const ingest = new KnowledgeIngest({
      sourceStore: store,
      credentials: creds,
      connectors: new ConnectorRegistry([new RestConnector()]),
    });
    cleanups.push(async () => {
      ingest.dispose();
      store.database.close();
      delete process.env.OCTOPI_TEST_REST_TOKEN;
    });

    const src = store.register({
      kind: 'connector',
      location: JSON.stringify({
        type: 'rest',
        listUrl: `${base}/api/docs`,
        itemsPath: 'results',
        pathField: 'id',
        contentField: 'body',
      }),
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'rest-docs',
      authRef: 'rest-demo',
      network: { allowPrivateNetwork: true },
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(15_000);

    expect(ingest.indexStore.search('API Key', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
    expect(ingest.indexStore.search('分钟', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
    const paths = ingest.indexStore.listFiles(src.id).map((f) => f.path);
    expect(paths).toContain('auth-guide');
    expect(paths).toContain('rate-limit');
  });

  it('supports urlField to fetch page content', async () => {
    const base = await start((req, res) => {
      const path = req.url ?? '';
      if (path.startsWith('/api/list')) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            items: [
              { id: 'p1', url: `${base}/pages/p1.html` },
            ],
          }),
        );
        return;
      }
      if (path === '/pages/p1.html') {
        res.setHeader('content-type', 'text/html');
        res.end('<html><body><p>独立页面正文内容</p></body></html>');
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const store = await KnowledgeSourceStore.open();
    const ingest = new KnowledgeIngest({
      sourceStore: store,
      connectors: new ConnectorRegistry([new RestConnector()]),
    });
    cleanups.push(async () => {
      ingest.dispose();
      store.database.close();
    });

    const src = store.register({
      kind: 'connector',
      location: JSON.stringify({
        listUrl: `${base}/api/list`,
        itemsPath: 'items',
        pathField: 'id',
        urlField: 'url',
      }),
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'rest-url',
      network: { allowPrivateNetwork: true },
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(15_000);
    expect(ingest.indexStore.search('独立页面', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
  });
});

describe('http_request credential', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    delete process.env.OCTOPI_TEST_HTTP_TOKEN;
  });

  it('injects credential headers server-side', async () => {
    let auth: string | undefined;
    const server = http.createServer((req, res) => {
      auth = req.headers.authorization;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    process.env.OCTOPI_TEST_HTTP_TOKEN = 'htok-9';
    const creds = await CredentialStore.open();
    creds.set({
      name: 'http-demo',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: 'OCTOPI_TEST_HTTP_TOKEN',
    });

    const tool = createHttpRequestTool({ credentials: creds });
    const result = await tool.handler(
      { url: `${base}/x`, method: 'GET', credential: 'http-demo' },
      {} as never,
    );

    expect(auth).toBe('Bearer htok-9');
    expect((result as { status: number }).status).toBe(200);
    expect(JSON.stringify(result)).not.toContain('htok-9');
  });

  it('throws when credential missing', async () => {
    const tool = createHttpRequestTool({ credentials: await CredentialStore.open() });
    await expect(
      tool.handler({ url: 'http://127.0.0.1:1/x', credential: 'nope' }, {} as never),
    ).rejects.toThrow(/credential not found/);
  });
});
