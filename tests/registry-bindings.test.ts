/**
 * T4a 渠道锚定（arch/multi-tenancy.md §9 + service-topology-p2 §2.3 ②）：
 * - RegistryService binding CRUD：租户内可管、换目标重验同租户、幂等删除、重复干净错误
 * - HTTP 面 /api/v1/registry/bindings：X-Registry-Token 身份、租户域收口、fail-loud 校验
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebApiRouter } from '@octopi-agent/gateway/web/api/router.js';
import type { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { RegistryService } from '@octopi-agent/engine/harness/governance/registry/service.js';
import type { AgentId, BindingId, TenantId, UserId } from '@octopi-agent/engine/harness/governance/registry/types.js';

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

describe('RegistryService binding CRUD', () => {
  let registry: RegistryService;
  let tA: TenantId;
  let tB: TenantId;
  let uA: UserId;
  let uB: UserId;
  let agentA: AgentId;
  let agentB: AgentId;

  beforeEach(async () => {
    registry = await RegistryService.create({ dbPath: ':memory:' });
    const a = registry.registerUser({ name: 'alice' });
    const b = registry.registerUser({ name: 'bob' });
    tA = a.tenant.tenantId;
    tB = b.tenant.tenantId;
    uA = a.user.userId;
    uB = b.user.userId;
    agentA = registry.createAgent({ tenantId: tA, ownerUserId: uA, name: 'agent-a' }).agentId;
    agentB = registry.createAgent({ tenantId: tB, ownerUserId: uB, name: 'agent-b' }).agentId;
  });
  afterEach(() => registry.close());

  it('createBinding → resolveBinding 回环；缺省 sessionPolicy=per-user', () => {
    const created = registry.createBinding({
      tenantId: tA,
      platform: 'weixin',
      identity: 'user-1',
      agentId: agentA,
    });
    expect(created.sessionPolicy).toBe('per-user');
    const resolved = registry.resolveBinding({ tenantId: tA, platform: 'weixin', identity: 'user-1' });
    expect(resolved?.bindingId).toBe(created.bindingId);
    expect(resolved?.agentId).toBe(agentA);
  });

  it('createBinding：目标 agent 跨租户拒（绑定不出租户）', () => {
    expect(() =>
      registry.createBinding({ tenantId: tA, platform: 'weixin', identity: 'u', agentId: agentB }),
    ).toThrow(/registry_cross_tenant_binding/);
  });

  it('createBinding：重复 (tenant, platform, identity) 出干净错误，不裸抛 SQLite', () => {
    registry.createBinding({ tenantId: tA, platform: 'weixin', identity: 'dup', agentId: agentA });
    expect(() =>
      registry.createBinding({ tenantId: tA, platform: 'weixin', identity: 'dup', agentId: agentA }),
    ).toThrow(/registry_binding_exists/);
  });

  it('createBinding：非法 sessionPolicy 拒', () => {
    expect(() =>
      registry.createBinding({
        tenantId: tA,
        platform: 'weixin',
        identity: 'u',
        agentId: agentA,
        sessionPolicy: 'per-room' as never,
      }),
    ).toThrow(/registry_invalid_session_policy/);
  });

  it('updateBinding：换目标 agent + 会话策略；跨租户目标拒', () => {
    const created = registry.createBinding({
      tenantId: tA,
      platform: 'weixin',
      identity: 'u',
      agentId: agentA,
    });
    const agentA2 = registry.createAgent({ tenantId: tA, ownerUserId: uA, name: 'agent-a2' }).agentId;
    const updated = registry.updateBinding({
      bindingId: created.bindingId,
      tenantId: tA,
      patch: { agentId: agentA2, sessionPolicy: 'per-chat' },
    });
    expect(updated.agentId).toBe(agentA2);
    expect(updated.sessionPolicy).toBe('per-chat');
    expect(() =>
      registry.updateBinding({
        bindingId: created.bindingId,
        tenantId: tA,
        patch: { agentId: agentB },
      }),
    ).toThrow(/registry_cross_tenant_binding/);
  });

  it('updateBinding：越域/不存在一律 registry_binding_not_found（不泄漏存在性）', () => {
    const created = registry.createBinding({
      tenantId: tA,
      platform: 'weixin',
      identity: 'u',
      agentId: agentA,
    });
    expect(() =>
      registry.updateBinding({
        bindingId: created.bindingId,
        tenantId: tB,
        patch: { sessionPolicy: 'per-chat' },
      }),
    ).toThrow(/registry_binding_not_found/);
    expect(() =>
      registry.updateBinding({
        bindingId: 'nope' as BindingId,
        tenantId: tA,
        patch: { sessionPolicy: 'per-chat' },
      }),
    ).toThrow(/registry_binding_not_found/);
  });

  it('deleteBinding：删后幂等 false；越域删除不删行', () => {
    const created = registry.createBinding({
      tenantId: tA,
      platform: 'weixin',
      identity: 'u',
      agentId: agentA,
    });
    expect(registry.deleteBinding({ bindingId: created.bindingId, tenantId: tB })).toBe(false);
    expect(registry.getBinding(created.bindingId)).not.toBeNull();
    expect(registry.deleteBinding({ bindingId: created.bindingId, tenantId: tA })).toBe(true);
    expect(registry.deleteBinding({ bindingId: created.bindingId, tenantId: tA })).toBe(false);
  });
});

describe('WebApiRouter /registry/bindings（HTTP 面）', () => {
  let registry: RegistryService;
  let router: WebApiRouter;
  let aliceToken: string;
  let bobToken: string;

  beforeEach(async () => {
    registry = await RegistryService.create({ dbPath: ':memory:' });
    const stub = {
      getRegistry: () => registry,
      attachRegistryAgent: async () => true,
      detachRegistryAgent: () => {},
    };
    router = new WebApiRouter({ gateway: stub as unknown as Gateway });
    const regA = await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'alice' } });
    aliceToken = (regA.body?.data as { token: string }).token;
    const regB = await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'bob' } });
    bobToken = (regB.body?.data as { token: string }).token;
  });
  afterEach(() => registry.close());

  async function createAgent(token: string, name: string): Promise<string> {
    const res = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/agents',
      token,
      body: { name },
    });
    expect(res.status).toBe(201);
    return (res.body?.data as { agentId: string }).agentId;
  }

  it('POST bindings：归属域=身份域；目标 agent 跨租户 400', async () => {
    const agentA = await createAgent(aliceToken, 'agent-a');
    const agentB = await createAgent(bobToken, 'agent-b');
    const ok = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/bindings',
      token: aliceToken,
      body: { platform: 'weixin', identity: 'u1', agentId: agentA, sessionPolicy: 'per-chat' },
    });
    expect(ok.status).toBe(201);
    expect((ok.body?.data as { sessionPolicy: string }).sessionPolicy).toBe('per-chat');

    const cross = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/bindings',
      token: aliceToken,
      body: { platform: 'weixin', identity: 'u2', agentId: agentB },
    });
    expect(cross.status).toBe(400);
    expect(cross.body?.error).toMatch(/registry_cross_tenant_binding/);
  });

  it('POST bindings：重复 triple 400 registry_binding_exists；缺字段 400', async () => {
    const agentA = await createAgent(aliceToken, 'agent-a');
    const body = { platform: 'weixin', identity: 'dup', agentId: agentA };
    await call(router, { method: 'POST', url: '/api/v1/registry/bindings', token: aliceToken, body });
    const dup = await call(router, { method: 'POST', url: '/api/v1/registry/bindings', token: aliceToken, body });
    expect(dup.status).toBe(409);
    expect(dup.body?.error).toMatch(/registry_binding_exists/);

    const missing = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/bindings',
      token: aliceToken,
      body: { platform: 'weixin' },
    });
    expect(missing.status).toBe(400);
  });

  it('POST bindings：非法 sessionPolicy 400 明示（与 PATCH 同口径，MIN-4）', async () => {
    const agentA = await createAgent(aliceToken, 'agent-a');
    const bad = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/bindings',
      token: aliceToken,
      body: { platform: 'weixin', identity: 'policy-check', agentId: agentA, sessionPolicy: 'per-room' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body?.error).toMatch(/registry_invalid_session_policy/);
  });

  it('GET bindings：身份域收口（各看各的，互不可见）', async () => {
    const agentA = await createAgent(aliceToken, 'agent-a');
    const agentB = await createAgent(bobToken, 'agent-b');
    await call(router, {
      method: 'POST',
      url: '/api/v1/registry/bindings',
      token: aliceToken,
      body: { platform: 'weixin', identity: 'u1', agentId: agentA },
    });
    await call(router, {
      method: 'POST',
      url: '/api/v1/registry/bindings',
      token: bobToken,
      body: { platform: 'weixin', identity: 'u1', agentId: agentB },
    });
    const listA = await call(router, { method: 'GET', url: '/api/v1/registry/bindings', token: aliceToken });
    const rowsA = listA.body?.data as unknown as Array<{ agentId: string }>;
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]!.agentId).toBe(agentA);
  });

  it('bindings 单条操作：平台 admin 可跨租户管（MIN-7 对齐知识面口径）', async () => {
    // alice 是首注册用户 = 平台 admin；bob 的 binding 由 alice 跨租户管
    const agentB = await createAgent(bobToken, 'agent-b');
    const created = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/bindings',
      token: bobToken,
      body: { platform: 'weixin', identity: 'admin-managed', agentId: agentB },
    });
    expect(created.status).toBe(201);
    const bindingId = (created.body?.data as { bindingId: string }).bindingId;

    const patched = await call(router, {
      method: 'PATCH',
      url: `/api/v1/registry/bindings/${bindingId}`,
      token: aliceToken,
      body: { sessionPolicy: 'per-chat' },
    });
    expect(patched.status).toBe(200);
    expect((patched.body?.data as { sessionPolicy: string }).sessionPolicy).toBe('per-chat');

    const got = await call(router, {
      method: 'GET',
      url: `/api/v1/registry/bindings/${bindingId}`,
      token: aliceToken,
    });
    expect(got.status).toBe(200);

    const deleted = await call(router, {
      method: 'DELETE',
      url: `/api/v1/registry/bindings/${bindingId}`,
      token: aliceToken,
    });
    expect(deleted.status).toBe(200);
  });

  it('PATCH bindings：换目标/策略生效；非法策略 400；空 patch 400', async () => {
    const agentA = await createAgent(aliceToken, 'agent-a');
    const agentA2 = await createAgent(aliceToken, 'agent-a2');
    const created = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/bindings',
      token: aliceToken,
      body: { platform: 'weixin', identity: 'u1', agentId: agentA },
    });
    const bindingId = (created.body?.data as { bindingId: string }).bindingId;

    const patched = await call(router, {
      method: 'PATCH',
      url: `/api/v1/registry/bindings/${bindingId}`,
      token: aliceToken,
      body: { agentId: agentA2, sessionPolicy: 'per-message' },
    });
    expect(patched.status).toBe(200);
    expect((patched.body?.data as { agentId: string }).agentId).toBe(agentA2);
    expect((patched.body?.data as { sessionPolicy: string }).sessionPolicy).toBe('per-message');

    const badPolicy = await call(router, {
      method: 'PATCH',
      url: `/api/v1/registry/bindings/${bindingId}`,
      token: aliceToken,
      body: { sessionPolicy: 'per-room' },
    });
    expect(badPolicy.status).toBe(400);
    expect(badPolicy.body?.error).toMatch(/registry_invalid_session_policy/);

    const empty = await call(router, {
      method: 'PATCH',
      url: `/api/v1/registry/bindings/${bindingId}`,
      token: aliceToken,
      body: {},
    });
    expect(empty.status).toBe(400);
  });

  it('PATCH/DELETE 越域：404 registry_binding_not_found（不泄漏存在性）', async () => {
    const agentA = await createAgent(aliceToken, 'agent-a');
    const created = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/bindings',
      token: aliceToken,
      body: { platform: 'weixin', identity: 'u1', agentId: agentA },
    });
    const bindingId = (created.body?.data as { bindingId: string }).bindingId;

    const crossPatch = await call(router, {
      method: 'PATCH',
      url: `/api/v1/registry/bindings/${bindingId}`,
      token: bobToken,
      body: { sessionPolicy: 'per-chat' },
    });
    expect(crossPatch.status).toBe(404);

    const crossDelete = await call(router, {
      method: 'DELETE',
      url: `/api/v1/registry/bindings/${bindingId}`,
      token: bobToken,
    });
    expect(crossDelete.status).toBe(404);
    expect(registry.getBinding(bindingId as BindingId)).not.toBeNull();

    const del = await call(router, {
      method: 'DELETE',
      url: `/api/v1/registry/bindings/${bindingId}`,
      token: aliceToken,
    });
    expect(del.status).toBe(200);
    expect((del.body?.data as { deleted: boolean }).deleted).toBe(true);
  });

  it('无 X-Registry-Token 一律 401（绑定是租户资产，无宿主面全量语义）', async () => {
    const res = await call(router, { method: 'GET', url: '/api/v1/registry/bindings' });
    expect(res.status).toBe(401);
  });
});
