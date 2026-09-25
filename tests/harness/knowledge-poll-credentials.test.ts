/**
 * U2 — encrypted 凭证 / poll 调度 / 条件 GET（304）
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialStore } from '../../src/harness/credentials/store.js';
import { decryptSecret, encryptSecret } from '../../src/harness/credentials/crypto.js';
import { KnowledgeSourceStore } from '../../src/harness/knowledge/source-store.js';
import { KnowledgeIngest } from '../../src/harness/knowledge/ingest.js';
import { UrlFetcher } from '../../src/harness/knowledge/fetchers.js';

const MASTER_HEX = 'a'.repeat(64);

describe('CredentialStore encrypted', () => {
  beforeEach(() => {
    process.env.OCTOPI_CREDENTIALS_KEY = MASTER_HEX;
  });
  afterEach(() => {
    delete process.env.OCTOPI_CREDENTIALS_KEY;
  });

  it('round-trips encrypt/decrypt', () => {
    const key = Buffer.from(MASTER_HEX, 'hex');
    const { cipher, nonce } = encryptSecret('hello-secret', key);
    expect(cipher.toString('utf8')).not.toContain('hello-secret');
    expect(decryptSecret(cipher, nonce, key)).toBe('hello-secret');
  });

  it('stores encrypted secret and resolves without leaking in meta', async () => {
    const store = await CredentialStore.open();
    const meta = store.set({
      name: 'enc-demo',
      kind: 'bearer',
      secretMode: 'encrypted',
      secretValue: 'enc-token-42',
    });
    expect(meta.hasSecret).toBe(true);
    expect(JSON.stringify(meta)).not.toContain('enc-token-42');
    expect(JSON.stringify(store.list())).not.toContain('enc-token-42');

    const resolved = await store.resolve('enc-demo');
    expect(resolved?.headers.Authorization).toBe('Bearer enc-token-42');
    expect(store.get('enc-demo')?.lastUsedAt).toBeGreaterThan(0);
  });

  it('fails write encrypted without master key', async () => {
    delete process.env.OCTOPI_CREDENTIALS_KEY;
    const store = await CredentialStore.open();
    expect(() =>
      store.set({ name: 'no-key', kind: 'bearer', secretMode: 'encrypted', secretValue: 'x' }),
    ).toThrow(/master key/);
  });
});

describe('poll + conditional GET', () => {
  const servers: http.Server[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });

  async function startServer(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('sends If-None-Match and skips reindex on 304', async () => {
    let hits = 0;
    let lastInm: string | undefined;
    const base = await startServer((req, res) => {
      hits += 1;
      lastInm = req.headers['if-none-match'] as string | undefined;
      if (lastInm === '"v1"') {
        res.statusCode = 304;
        res.end();
        return;
      }
      res.setHeader('etag', '"v1"');
      res.setHeader('content-type', 'text/html');
      res.end('<html><body><p>条件请求文档内容</p></body></html>');
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
      displayName: 'cond',
      network: { allowPrivateNetwork: true },
      sync: { strategy: 'poll', intervalMs: 0, enabled: true },
    });

    await ingest.ingestSource(src.id);
    await ingest.idle(10_000);
    expect(ingest.indexStore.search('条件请求', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
    const file = ingest.indexStore.getFile(src.id, 'doc.html');
    expect(file?.etag).toBe('"v1"');
    const firstHits = hits;

    await ingest.ingestSource(src.id);
    await ingest.idle(10_000);
    expect(hits).toBe(firstHits + 1);
    expect(lastInm).toBe('"v1"');
    // 304 后索引仍在
    expect(ingest.indexStore.search('条件请求', { sourceIds: [src.id] }).length).toBeGreaterThan(0);
  });

  it('pollDueSources only fires due poll sources and respects min interval', async () => {
    const base = await startServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<html><body><p>poll body content</p></body></html>');
    });

    const store = await KnowledgeSourceStore.open();
    const ingest = new KnowledgeIngest({
      sourceStore: store,
      pollMinIntervalMs: 60_000,
      maxPollPerTick: 4,
      fetchers: { url: new UrlFetcher({ allowPrivateNetwork: true }) },
    });
    cleanups.push(async () => {
      ingest.dispose();
      store.database.close();
    });

    const pollSrc = store.register({
      kind: 'url',
      location: `${base}/a.html`,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'poll-a',
      network: { allowPrivateNetwork: true },
      sync: { strategy: 'poll', intervalMs: 1, enabled: true },
    });
    const manualSrc = store.register({
      kind: 'url',
      location: `${base}/b.html`,
      scopeRef: { level: 'global', key: 'global' },
      displayName: 'manual-b',
      network: { allowPrivateNetwork: true },
      sync: { strategy: 'manual', enabled: true },
    });

    const first = await ingest.pollDueSources();
    expect(first).toContain(pollSrc.id);
    expect(first).not.toContain(manualSrc.id);
    await ingest.idle(10_000);

    // 刚 poll 过：未到 min interval，不再触发
    const second = await ingest.pollDueSources();
    expect(second).not.toContain(pollSrc.id);
  });
});
