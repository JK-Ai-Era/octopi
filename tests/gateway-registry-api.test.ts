/**
 * WebApiRouter /registry/* — 租户与定义面 HTTP 面（arch/multi-tenancy.md T1b）。
 *
 * 鉴权两层：上游 apiKey 闸（宿主面，本测不涉及）+ 租户身份层（Bearer token）。
 * 用真实 RegistryService（:memory:）——只仿真 HTTP 边界（req/res），不动库内逻辑。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebApiRouter } from '@octopi-agent/gateway/web/api/router.js';
import type { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { RegistryService } from '@octopi-agent/engine/harness/governance/registry/service.js';

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
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
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

function routerWith(registry: RegistryService | undefined): WebApiRouter {
  const stub = { getRegistry: () => registry };
  return new WebApiRouter({ gateway: stub as unknown as Gateway });
}

describe('WebApiRouter /registry — 注册/登录（一用户一租户）', () => {
  let registry: RegistryService;
  let router: WebApiRouter;
  beforeEach(async () => {
    registry = await RegistryService.create({ dbPath: ':memory:' });
    router = routerWith(registry);
  });
  afterEach(() => registry.close());

  it('POST /registry/register → 201 {tenant,user,token}；首个用户为平台 admin', async () => {
    const res = await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'alice' } });
    expect(res.status).toBe(201);
    const data = res.body?.data as { tenant: { tenantId: string }; user: { userId: string; isPlatformAdmin: boolean }; token: string };
    expect(data.user.isPlatformAdmin).toBe(true);
    expect(data.tenant.tenantId).not.toBe(data.user.userId);
    expect(data.token).toBeTruthy();
  });

  it('同名注册 → 409（UNIQUE 映射）', async () => {
    await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'alice' } });
    const dup = await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'alice' } });
    expect(dup.status).toBe(409);
  });

  it('POST /registry/login 按名直登（演练级）→ token 可用；未知名 → 404', async () => {
    await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'alice' } });
    const login = await call(router, { method: 'POST', url: '/api/v1/registry/login', body: { name: 'alice' } });
    expect(login.status).toBe(200);
    const { token } = login.body?.data as { token: string };
    const me = await call(router, { method: 'GET', url: '/api/v1/registry/me', token });
    expect(me.status).toBe(200);
    const missing = await call(router, { method: 'POST', url: '/api/v1/registry/login', body: { name: 'nobody' } });
    expect(missing.status).toBe(404);
  });

  it('缺/错 token → 401；logout 后失效', async () => {
    expect((await call(router, { method: 'GET', url: '/api/v1/registry/me' })).status).toBe(401);
    expect(
      (await call(router, { method: 'GET', url: '/api/v1/registry/me', token: 'bogus' })).status,
    ).toBe(401);
    const reg = await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'alice' } });
    const { token } = reg.body?.data as { token: string };
    await call(router, { method: 'POST', url: '/api/v1/registry/logout', token });
    expect((await call(router, { method: 'GET', url: '/api/v1/registry/me', token })).status).toBe(401);
  });
});

describe('WebApiRouter /registry — agents 与 bindings（租户边界）', () => {
  let registry: RegistryService;
  let router: WebApiRouter;
  let aliceToken: string;
  let bobToken: string;
  beforeEach(async () => {
    registry = await RegistryService.create({ dbPath: ':memory:' });
    router = routerWith(registry);
    aliceToken = (
      await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'alice' } })
    ).body?.data?.token as string;
    bobToken = (
      await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'bob' } })
    ).body?.data?.token as string;
  });
  afterEach(() => registry.close());

  it('POST/GET /registry/agents：创建与列表（可见性=private 仅 owner）', async () => {
    const created = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/agents',
      token: aliceToken,
      body: { name: 'helper', definition: '{"model":"gpt"}' },
    });
    expect(created.status).toBe(201);
    const list = await call(router, { method: 'GET', url: '/api/v1/registry/agents', token: aliceToken });
    expect((list.body?.data as unknown as unknown[]).length).toBe(1);
    const bobList = await call(router, { method: 'GET', url: '/api/v1/registry/agents', token: bobToken });
    expect((bobList.body?.data as unknown as unknown[]).length).toBe(0);
  });

  it('PATCH/DELETE 越权（他租户用户）→ 403', async () => {
    const created = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/agents',
      token: aliceToken,
      body: { name: 'helper' },
    });
    const agentId = created.body?.data?.agentId as string;
    const hack = await call(router, {
      method: 'PATCH',
      url: `/api/v1/registry/agents/${agentId}`,
      token: bobToken,
      body: { name: 'hacked' },
    });
    expect(hack.status).toBe(403);
    const del = await call(router, {
      method: 'DELETE',
      url: `/api/v1/registry/agents/${agentId}`,
      token: bobToken,
    });
    expect(del.status).toBe(403);
  });

  it('PATCH 合法更新 + DELETE 成功', async () => {
    const created = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/agents',
      token: aliceToken,
      body: { name: 'helper' },
    });
    const agentId = created.body?.data?.agentId as string;
    const patch = await call(router, {
      method: 'PATCH',
      url: `/api/v1/registry/agents/${agentId}`,
      token: aliceToken,
      body: { visibility: 'tenant', name: 'renamed' },
    });
    expect(patch.status).toBe(200);
    expect(patch.body?.data?.name).toBe('renamed');
    const del = await call(router, {
      method: 'DELETE',
      url: `/api/v1/registry/agents/${agentId}`,
      token: aliceToken,
    });
    expect(del.body?.data?.deleted).toBe(true);
  });

  it('POST /registry/bindings：同租户 ok；跨租户 agent → 400', async () => {
    const aliceAgent = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/agents',
      token: aliceToken,
      body: { name: 'a1' },
    });
    const bobAgent = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/agents',
      token: bobToken,
      body: { name: 'b1' },
    });
    const ok = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/bindings',
      token: aliceToken,
      body: { platform: 'feishu', identity: 'ou_x', agentId: aliceAgent.body?.data?.agentId },
    });
    expect(ok.status).toBe(201);
    const cross = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/bindings',
      token: aliceToken,
      body: { platform: 'wechat', identity: 'openid-1', agentId: bobAgent.body?.data?.agentId },
    });
    expect(cross.status).toBe(400);
    expect(cross.body?.error).toMatch(/cross_tenant_binding/);
    const list = await call(router, { method: 'GET', url: '/api/v1/registry/bindings', token: aliceToken });
    expect((list.body?.data as unknown as unknown[]).length).toBe(1);
  });

  it('registry 未就绪 → 503；未知 registry 路由 → 404', async () => {
    const bare = routerWith(undefined);
    expect((await call(bare, { method: 'GET', url: '/api/v1/registry/me', token: 'x' })).status).toBe(503);
    expect(
      (await call(router, { method: 'GET', url: '/api/v1/registry/nope', token: aliceToken })).status,
    ).toBe(404);
  });
});
