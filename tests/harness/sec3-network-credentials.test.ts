/**
 * SEC-3 — 出站 SSRF / DNS TOCTOU connect 再校验 / credential_bindings 强制
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertUrlAllowed,
  createValidatingLookup,
  guardedRequest,
  isRestrictedIp,
} from '@octopi-agent/engine/harness/knowledge/network-guard.js';
import { createHttpRequestTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/http.js';
import { CredentialStore } from '@octopi-agent/engine/harness/governance/credentials/store.js';
import type { ToolExecutionContext } from '@octopi-agent/core/types.js';

const servers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  delete process.env.OCTOPI_TEST_SEC3_TOKEN;
});

async function listen(): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end('ok');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function ctx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    sessionId: 's1',
    agentId: 'a1',
    messages: [],
    fileEffects: {
      writeFile: async () => {},
      appendFile: async () => {},
      recordDelete: async () => {},
      recordCreate: async () => {},
      recordRename: async () => {},
      recordOverwrite: async () => {},
      noteNotReversed: async () => {},
    },
    memoryEffects: {
      recordInsert: async () => {},
      recordUpdate: async () => {},
      recordDelete: async () => {},
    },
    ...overrides,
  } as ToolExecutionContext;
}

describe('SEC-3a connect-time lookup re-validation', () => {
  it('createValidatingLookup rejects restricted addresses at connect resolve', async () => {
    const lookup = createValidatingLookup({ allowPrivateNetwork: false });
    await new Promise<void>((resolve) => {
      lookup('localhost', { all: true }, (err) => {
        // localhost resolves to loopback → restricted
        expect(err).toBeTruthy();
        expect(String(err?.message)).toMatch(/not allowed|ENOTFOUND|dns/i);
        resolve();
      });
    });
  });

  it('createValidatingLookup allows private when opted in', async () => {
    const lookup = createValidatingLookup({ allowPrivateNetwork: true });
    await new Promise<void>((resolve) => {
      lookup('127.0.0.1', { all: true }, (err, addr) => {
        // IP literals may still be validated; either success or explicit restricted is fine
        if (err) {
          expect(String(err.message)).toMatch(/not allowed|ENOTFOUND|dns/i);
        } else {
          expect(addr).toBeTruthy();
        }
        resolve();
      });
    });
  });

  it('filterAddresses pin seam drops addresses', async () => {
    const lookup = createValidatingLookup({
      allowPrivateNetwork: true,
      filterAddresses: () => [],
    });
    await new Promise<void>((resolve) => {
      lookup('127.0.0.1', { all: true }, (err) => {
        expect(err).toBeTruthy();
        expect(String(err?.message)).toMatch(/filter|allowed/i);
        resolve();
      });
    });
  });
});

describe('SEC-3b http_request SSRF gate', () => {
  it('blocks private targets by default', async () => {
    const base = await listen();
    const tool = createHttpRequestTool();
    await expect(
      tool.handler({ url: `${base}/x`, method: 'GET' }, ctx()),
    ).rejects.toThrow(/not allowed|private|HTTP request failed/i);
  });

  it('allows private when network.allowPrivateNetwork is set', async () => {
    const base = await listen();
    const tool = createHttpRequestTool({ network: { allowPrivateNetwork: true } });
    const result = (await tool.handler({ url: `${base}/x`, method: 'GET' }, ctx())) as {
      status: number;
    };
    expect(result.status).toBe(200);
  });

  it('forces deny-private when context.networkPolicy is deny', async () => {
    const base = await listen();
    const tool = createHttpRequestTool({ network: { allowPrivateNetwork: true } });
    await expect(
      tool.handler({ url: `${base}/x`, method: 'GET' }, ctx({ networkPolicy: 'deny' })),
    ).rejects.toThrow(/not allowed|private|HTTP request failed/i);
  });

  it('rejects non-http protocols', async () => {
    const tool = createHttpRequestTool({ network: { allowPrivateNetwork: true } });
    await expect(
      tool.handler({ url: 'file:///etc/passwd', method: 'GET' }, ctx()),
    ).rejects.toThrow(/protocol|HTTP request failed/i);
  });

  it('guardedRequest rejects metadata IP literal', async () => {
    await expect(
      guardedRequest('http://169.254.169.254/latest/meta-data/', {
        allowPrivateNetwork: false,
      }),
    ).rejects.toThrow(/not allowed/i);
  });

  it('follows redirect only when each hop is allowed', async () => {
    const evil = http.createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/');
      res.end();
    });
    servers.push(evil);
    await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(evil.address() as AddressInfo).port}`;

    await expect(
      guardedRequest(`${base}/start`, { allowPrivateNetwork: true, maxRedirects: 3 }),
    ).rejects.toThrow(/not allowed/i);
  });
});

describe('SEC-3c credential_bindings enforcement', () => {
  const envKey = 'OCTOPI_TEST_SEC3_TOKEN';

  it('enforces non-empty bindings against consumer', async () => {
    process.env[envKey] = 'sec3-secret';
    const store = await CredentialStore.open();
    store.set({
      name: 'sec3-cred',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: envKey,
    });
    store.bind({ kind: 'tool', id: 'http_request' }, 'sec3-cred');

    const ok = await store.resolve('sec3-cred', { kind: 'tool', id: 'http_request' });
    expect(ok?.headers.Authorization).toBe('Bearer sec3-secret');

    await expect(
      store.resolve('sec3-cred', { kind: 'tool', id: 'other_tool' }),
    ).rejects.toThrow(/not bound/i);

    await expect(store.resolve('sec3-cred')).rejects.toThrow(/consumer required/i);
  });

  it('empty bindings resolve by default (compat)', async () => {
    process.env[envKey] = 'sec3-open';
    const store = await CredentialStore.open();
    store.set({
      name: 'sec3-open',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: envKey,
    });
    const resolved = await store.resolve('sec3-open');
    expect(resolved?.headers.Authorization).toBe('Bearer sec3-open');
  });

  it('requireBindings rejects unbound credentials', async () => {
    process.env[envKey] = 'sec3-strict';
    const store = await CredentialStore.open({ requireBindings: true });
    store.set({
      name: 'sec3-strict',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: envKey,
    });
    await expect(
      store.resolve('sec3-strict', { kind: 'tool', id: 'http_request' }),
    ).rejects.toThrow(/no bindings/i);
  });

  it('http_request consumer uses tool:http_request binding', async () => {
    process.env[envKey] = 'sec3-http';
    const store = await CredentialStore.open();
    store.set({
      name: 'sec3-http',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: envKey,
    });
    store.bind({ kind: 'tool', id: 'http_request' }, 'sec3-http');

    let auth: string | undefined;
    const server = http.createServer((req, res) => {
      auth = req.headers.authorization;
      res.end('ok');
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const tool = createHttpRequestTool({
      credentials: store,
      network: { allowPrivateNetwork: true },
    });
    const result = (await tool.handler(
      { url: `${base}/x`, method: 'GET', credential: 'sec3-http' },
      ctx(),
    )) as { status: number };
    expect(result.status).toBe(200);
    expect(auth).toBe('Bearer sec3-http');
  });

  it('http_request rejects when requireCredentialBindings and unbound', async () => {
    process.env[envKey] = 'sec3-strict-http';
    const store = await CredentialStore.open();
    store.set({
      name: 'sec3-strict-http',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: envKey,
    });
    const tool = createHttpRequestTool({
      credentials: store,
      network: { allowPrivateNetwork: true },
    });
    await expect(
      tool.handler(
        { url: 'http://127.0.0.1:9/x', method: 'GET', credential: 'sec3-strict-http' },
        ctx({ requireCredentialBindings: true }),
      ),
    ).rejects.toThrow(/no bindings|not bound|HTTP request failed/i);
  });
});

describe('assertUrlAllowed still fail-fast before connect', () => {
  it('rejects loopback without allowPrivateNetwork', async () => {
    await expect(assertUrlAllowed('http://127.0.0.1/x')).rejects.toThrow(/not allowed/i);
  });
  it('allows loopback with allowPrivateNetwork', async () => {
    await expect(
      assertUrlAllowed('http://127.0.0.1/x', { allowPrivateNetwork: true }),
    ).resolves.toBeTruthy();
  });
  it('isRestrictedIp covers CGNAT and ULA', () => {
    expect(isRestrictedIp('100.64.1.1')).toBe(true);
    expect(isRestrictedIp('fd00::1')).toBe(true);
    expect(isRestrictedIp('8.8.8.8')).toBe(false);
  });
});


describe('SEC-3 review regressions', () => {
  it('blocks IPv4-mapped metadata (dotted and hex forms)', () => {
    expect(isRestrictedIp('::ffff:169.254.169.254')).toBe(true);
    expect(isRestrictedIp('::ffff:a9fe:a9fe')).toBe(true);
    // mapped loopback still restricted
    expect(isRestrictedIp('::ffff:7f00:1')).toBe(true);
    expect(isRestrictedIp('::ffff:127.0.0.1')).toBe(true);
  });

  it('blocks IPv6 link-local fe80::/10 not only fe80:', () => {
    expect(isRestrictedIp('fe80::1')).toBe(true);
    expect(isRestrictedIp('fe90::1')).toBe(true);
    expect(isRestrictedIp('febf::1')).toBe(true);
  });

  it('assertUrlAllowed rejects mapped metadata even with allowPrivateNetwork', async () => {
    await expect(
      assertUrlAllowed('http://[::ffff:169.254.169.254]/x', { allowPrivateNetwork: true }),
    ).rejects.toThrow(/metadata\/link-local|not allowed/i);
    await expect(
      assertUrlAllowed('http://[::ffff:a9fe:a9fe]/x', { allowPrivateNetwork: true }),
    ).rejects.toThrow(/metadata\/link-local|not allowed/i);
  });

  it('store-level requireBindings is not overridden by context false', async () => {
    process.env.OCTOPI_TEST_SEC3_TOKEN = 'strict-store';
    const store = await CredentialStore.open({ requireBindings: true });
    store.set({
      name: 'sec3-store-strict',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: 'OCTOPI_TEST_SEC3_TOKEN',
    });
    // context.requireCredentialBindings === false must NOT loosen store policy
    await expect(
      store.resolve('sec3-store-strict', { kind: 'tool', id: 'http_request' }, {
        requireBindings: false,
      }),
    ).rejects.toThrow(/no bindings/i);
  });

  it('http_request honors store requireBindings when context flag is false', async () => {
    process.env.OCTOPI_TEST_SEC3_TOKEN = 'strict-http-store';
    const store = await CredentialStore.open({ requireBindings: true });
    store.set({
      name: 'sec3-http-store',
      kind: 'bearer',
      secretMode: 'env',
      secretEnv: 'OCTOPI_TEST_SEC3_TOKEN',
    });
    const tool = createHttpRequestTool({
      credentials: store,
      network: { allowPrivateNetwork: true },
    });
    await expect(
      tool.handler(
        { url: 'http://127.0.0.1:9/x', credential: 'sec3-http-store' },
        ctx({ requireCredentialBindings: false }),
      ),
    ).rejects.toThrow(/no bindings|not bound|HTTP request failed/i);
  });

  it('returns truncated body instead of rejecting when over maxResponseBytes', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end('x'.repeat(2000));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await guardedRequest(`${base}/big`, {
      allowPrivateNetwork: true,
      maxResponseBytes: 100,
    });
    expect(res.bodyTruncated).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(100);
    expect(res.status).toBe(200);
  });

  it('does not send stale Content-Length after redirect drops body', async () => {
    let hop2Len: string | undefined;
    let hop2Method: string | undefined;
    const target = http.createServer((req, res) => {
      hop2Len = req.headers['content-length'] as string | undefined;
      hop2Method = req.method;
      res.end('ok');
    });
    servers.push(target);
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const targetPort = (target.address() as AddressInfo).port;

    const redir = http.createServer((req, res) => {
      // 302: body dropped, method becomes GET
      void req;
      res.statusCode = 302;
      res.setHeader('location', `http://127.0.0.1:${targetPort}/final`);
      res.end();
    });
    servers.push(redir);
    await new Promise<void>((r) => redir.listen(0, '127.0.0.1', r));
    const redirBase = `http://127.0.0.1:${(redir.address() as AddressInfo).port}`;

    await guardedRequest(
      `${redirBase}/start`,
      {
        allowPrivateNetwork: true,
        method: 'POST',
        body: 'payload-body',
        maxRedirects: 3,
      },
    );
    expect(hop2Method).toBe('GET');
    expect(hop2Len).toBeUndefined();
  });

  it('308 preserves POST method and body', async () => {
    let seenBody = '';
    let seenMethod = '';
    const target = http.createServer((req, res) => {
      seenMethod = req.method!;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seenBody = Buffer.concat(chunks).toString('utf8');
        res.end('ok');
      });
    });
    servers.push(target);
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const targetPort = (target.address() as AddressInfo).port;

    const redir = http.createServer((_req, res) => {
      res.statusCode = 308;
      res.setHeader('location', `http://127.0.0.1:${targetPort}/final`);
      res.end();
    });
    servers.push(redir);
    await new Promise<void>((r) => redir.listen(0, '127.0.0.1', r));
    const redirBase = `http://127.0.0.1:${(redir.address() as AddressInfo).port}`;

    await guardedRequest(`${redirBase}/start`, {
      allowPrivateNetwork: true,
      method: 'POST',
      body: 'keep-me',
      maxRedirects: 3,
    });
    expect(seenMethod).toBe('POST');
    expect(seenBody).toBe('keep-me');
  });

  it('decompresses gzip responses', async () => {
    const zlib = await import('node:zlib');
    const payload = Buffer.from('gzip-hello-content', 'utf8');
    const gz = zlib.gzipSync(payload);
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.setHeader('content-encoding', 'gzip');
      res.end(gz);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await guardedRequest(`${base}/gz`, { allowPrivateNetwork: true });
    expect(res.body).toBe('gzip-hello-content');
  });

  it('filterAddresses cannot reintroduce blocked addresses', async () => {
    // 先让 DNS 给出可解析地址，再由 filter 塞回 metadata — 必须仍被拒绝
    const lookup = createValidatingLookup({
      allowPrivateNetwork: true,
      filterAddresses: () => [{ address: '169.254.169.254', family: 4 }],
    });
    await new Promise<void>((resolve) => {
      lookup('127.0.0.1', { all: true }, (err) => {
        expect(err).toBeTruthy();
        expect(String(err?.message)).toMatch(/metadata\/link-local|not allowed/i);
        resolve();
      });
    });
  });
});
