/**
 * GET /agents 读身份收口（arch/multi-tenancy.md §9.1-17，R5 残余①）：
 * host 面/平台 admin = 全量（运维语义不变）；注册用户 = 本租户 agents
 * （agentOwnershipTenant 归属单源），不得枚举他租户 agent id。
 */
import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebApiRouter } from '@octopi-agent/gateway/web/api/router.js';
import type { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';

interface CallResult {
  status: number;
  body?: { ok?: boolean; data?: unknown; error?: string };
}

async function call(
  router: WebApiRouter,
  opts: { method?: string; url: string; token?: string } = { url: '' },
): Promise<CallResult> {
  const chunks: Buffer[] = [];
  let statusCode = 0;
  const req = {
    method: opts.method ?? 'GET',
    url: opts.url,
    headers: {
      ...(opts.token ? { 'x-registry-token': opts.token } : {}),
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('');
    },
    on: () => undefined,
  } as unknown as IncomingMessage;
  const res = {
    writeHead: (code: number) => {
      statusCode = code;
    },
    setHeader: () => undefined,
    end: (payload?: string) => {
      if (payload) chunks.push(Buffer.from(payload));
    },
    write: (payload: string) => {
      chunks.push(Buffer.from(payload));
    },
  } as unknown as ServerResponse;
  await router.handle(req, res);
  const raw = Buffer.concat(chunks).toString('utf8');
  return { status: statusCode, body: raw ? (JSON.parse(raw) as CallResult['body']) : undefined };
}

function makeRouter(): WebApiRouter {
  const users: Record<
    string,
    { userId: string; tenantId: string; isPlatformAdmin: boolean } | null
  > = {
    'tok-admin': { userId: 'u-admin', tenantId: 'tenant-admin', isPlatformAdmin: true },
    'tok-acme': { userId: 'u-acme', tenantId: 'acme', isPlatformAdmin: false },
    bad: null,
  };
  const stub = {
    getRegistry: () => ({
      resolveToken: (t: string) => users[t] ?? null,
    }),
    getRegisteredAgents: () => [
      { id: 'a-acme-1', model: {}, effectMode: 'workspace', effectModeSource: 'default' },
      { id: 'a-acme-2', model: {}, effectMode: 'workspace', effectModeSource: 'default' },
      { id: 'a-other-1', model: {}, effectMode: 'workspace', effectModeSource: 'default' },
    ],
    agentOwnershipTenant: (id: string) => (id.startsWith('a-acme') ? 'acme' : 'other-tenant'),
    getAgentEffectiveMode: () => 'workspace',
  };
  return new WebApiRouter({ gateway: stub as unknown as Gateway });
}

function ids(body?: CallResult['body']): string[] {
  return ((body?.data ?? []) as Array<{ id: string }>).map((a) => a.id);
}

describe('GET /agents 读身份收口（§9.1-17）', () => {
  it('host 面（无 token）= 全量（运维语义不变）', async () => {
    const r = await call(makeRouter(), { url: '/api/v1/agents' });
    expect(r.status).toBe(200);
    expect(ids(r.body)).toEqual(['a-acme-1', 'a-acme-2', 'a-other-1']);
  });

  it('平台 admin = 全量', async () => {
    const r = await call(makeRouter(), { url: '/api/v1/agents', token: 'tok-admin' });
    expect(ids(r.body)).toEqual(['a-acme-1', 'a-acme-2', 'a-other-1']);
  });

  it('注册用户 = 本租户 agents（不得枚举他租户 agent id）', async () => {
    const r = await call(makeRouter(), { url: '/api/v1/agents', token: 'tok-acme' });
    expect(ids(r.body)).toEqual(['a-acme-1', 'a-acme-2']);
    expect(ids(r.body)).not.toContain('a-other-1');
  });

  it('无效 token → 401', async () => {
    const r = await call(makeRouter(), { url: '/api/v1/agents', token: 'bad' });
    expect(r.status).toBe(401);
  });
});
