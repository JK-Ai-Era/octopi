/**
 * registry 面建源围栏（独立评审 MAJOR-6 锚 (a)）：`POST /api/v1/registry/knowledge-sources`
 * 对内部态 location 必须 403 `knowledge_location_forbidden`；kind 无白名单不得进围栏
 * （NIT-12）；落库形态 = 围栏裁决的 canonical（MAJOR-5）。
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebApiRouter } from '@octopi-agent/gateway/web/api/router.js';
import type { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { resolveCanonicalLocation } from '@octopi-agent/engine/harness/knowledge/location.js';

interface CallResult {
  status: number;
  body: { ok: boolean; error?: string; data?: Record<string, unknown> } | null;
}

async function call(
  router: WebApiRouter,
  opts: { method: string; url: string; body?: unknown; token?: string },
): Promise<CallResult> {
  const payload = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const headers: Record<string, string> = { host: 'localhost' };
  if (opts.token) headers['x-registry-token'] = opts.token;
  const req = {
    url: opts.url,
    method: opts.method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (payload) yield Buffer.from(payload);
    },
  } as unknown as IncomingMessage;
  let status = 0;
  let body: CallResult['body'] = null;
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    setHeader() {
      return this;
    },
    end(out?: string) {
      body = out ? JSON.parse(out) : null;
      return this;
    },
  } as unknown as ServerResponse;
  await router.handle(req, res);
  return { status, body };
}

describe('registry 面建源 location 围栏（R5；评审 BLOCKER-1/MAJOR-5/NIT-12）', () => {
  it('内部态 403 knowledge_location_forbidden；非法 kind 400；合法源落库 canonical', async () => {
    const prevHome = process.env.OCTOPI_HOME;
    const home = mkdtempSync(join(tmpdir(), 'octopi-reg-fence-'));
    mkdirSync(join(home, 'sessions'), { recursive: true });
    process.env.OCTOPI_HOME = home;
    try {
      const created: Array<{ input: Record<string, unknown>; claim?: unknown }> = [];
      const client = {
        createSource: (input: Record<string, unknown>, claim?: unknown) => {
          created.push({ input, claim });
          return Promise.resolve({ id: 'ks_reg1', ...input });
        },
        deleteSource: () => Promise.resolve({ removed: true }),
      };
      const user = { userId: 'u1', tenantId: 'tenant-a', isPlatformAdmin: false };
      const stub = {
        getRegistry: () => ({
          resolveToken: (t: string) => (t === 'tok-u1' ? user : null),
          createKnowledgeSource: (input: Record<string, unknown>) => ({ sourceId: 'r1', ...input }),
          listKnowledgeSources: () => [],
        }),
        getKnowledgeClient: () => Promise.resolve(client),
      };
      const router = new WebApiRouter({ gateway: stub as unknown as Gateway });

      // 内部态（sessions/）拒
      const forbidden = await call(router, {
        method: 'POST',
        url: '/api/v1/registry/knowledge-sources',
        token: 'tok-u1',
        body: { name: 'x', kind: 'directory', location: join(home, 'sessions') },
      });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body?.error).toMatch(/knowledge_location_forbidden/);
      expect(created).toHaveLength(0);

      // kind 白名单（NIT-12）：未校验串不得进围栏判定
      const badKind = await call(router, {
        method: 'POST',
        url: '/api/v1/registry/knowledge-sources',
        token: 'tok-u1',
        body: { name: 'x', kind: 'evil-kind', location: '/data/docs' },
      });
      expect(badKind.status).toBe(400);
      expect(badKind.body?.error).toMatch(/invalid kind/);

      // 合法外部路径：落库形态 = 围栏裁决的 canonical（MAJOR-5）
      const outside = mkdtempSync(join(tmpdir(), 'octopi-reg-ok-'));
      try {
        const ok = await call(router, {
          method: 'POST',
          url: '/api/v1/registry/knowledge-sources',
          token: 'tok-u1',
          body: { name: 'docs', kind: 'directory', location: join(outside, 'docs') },
        });
        expect(ok.status).toBe(201);
        expect(created).toHaveLength(1);
        expect(created[0]!.input['location']).toBe(resolveCanonicalLocation(join(outside, 'docs')));
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      if (prevHome === undefined) delete process.env.OCTOPI_HOME;
      else process.env.OCTOPI_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
