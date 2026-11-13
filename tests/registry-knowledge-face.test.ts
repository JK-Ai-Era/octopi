/**
 * T3b registry 知识面（arch/multi-tenancy.md §6/§10.3）：
 * - 定义面：knowledge sources（platform|tenant 两级所有权）+ mounts（租户内挂载）
 * - HTTP 面：物化纪律（registry=定义、knowledge.db=执法；补偿永远朝少可见方向）
 * - platform 保留字；session 挂载 agentRef；project 挂载物化 501 fail-loud
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebApiRouter } from '@octopi-agent/gateway/web/api/router.js';
import type { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { RegistryService } from '@octopi-agent/engine/harness/governance/registry/service.js';
import type { TenantId, MountId } from '@octopi-agent/engine/harness/governance/registry/types.js';

interface CallResult {
  status: number;
  body: { ok: boolean; error?: string; data?: Record<string, unknown> } | null;
}

/** 假知识面客户端：记录物化调用（断言物化方向与补偿） */
function fakeKnowledgeClient(log: Array<{ op: string; args: unknown[] }>) {
  return {
    createSource: async (...args: unknown[]) => {
      log.push({ op: 'createSource', args });
      return { id: `ks_${log.length}` };
    },
    deleteSource: async (...args: unknown[]) => {
      log.push({ op: 'deleteSource', args });
      return true;
    },
    setAgentVisibility: async (...args: unknown[]) => {
      log.push({ op: 'setAgentVisibility', args });
      return {};
    },
    setSessionVisibility: async (...args: unknown[]) => {
      log.push({ op: 'setSessionVisibility', args });
      return {};
    },
    clearSessionVisibility: async (...args: unknown[]) => {
      log.push({ op: 'clearSessionVisibility', args });
      return {};
    },
  };
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

describe('RegistryService 知识面（定义）', () => {
  let registry: RegistryService;
  let tA: TenantId;
  let tB: TenantId;
  beforeEach(async () => {
    registry = await RegistryService.create({ dbPath: ':memory:' });
    // requireTenant：定义面挂租户须是注册租户（registerUser 生成真实 id）
    tA = registry.registerUser({ name: 'alice' }).tenant.tenantId;
    tB = registry.registerUser({ name: 'bob' }).tenant.tenantId;
  });
  afterEach(() => registry.close());

  it('保留字：scope=tenant + tenantId=platform 一律拒（platform 是域哨兵不是租户）', () => {
    expect(() =>
      registry.createKnowledgeSource({
        scope: 'tenant',
        tenantId: 'platform' as TenantId,
        name: 'x',
      }),
    ).toThrow(/reserved/);
  });

  it('sourceId 链接：受管注册以知识面行 id 登记所有权', () => {
    const src = registry.createKnowledgeSource({
      scope: 'tenant',
      tenantId: tA,
      name: 'linked',
      sourceId: 'ks_linked',
    });
    expect(src.sourceId).toBe('ks_linked');
    expect(src.tenantId).toBe(tA);
  });

  it('listKnowledgeSources：admin 全量；租户=platform ∪ 本域', () => {
    registry.createKnowledgeSource({ scope: 'platform', name: 'p' });
    registry.createKnowledgeSource({ scope: 'tenant', tenantId: tA, name: 'a' });
    registry.createKnowledgeSource({ scope: 'tenant', tenantId: tB, name: 'b' });

    const admin = registry.listKnowledgeSources({ viewerTenantId: tA, isPlatformAdmin: true });
    expect(admin).toHaveLength(3);
    const scoped = registry.listKnowledgeSources({ viewerTenantId: tA, isPlatformAdmin: false });
    expect(scoped.map((s) => s.name).sort()).toEqual(['a', 'p']);
  });

  it('deleteKnowledgeSource：跨租户拒；非 admin 删 platform 库拒；连带删挂载', () => {
    const src = registry.createKnowledgeSource({ scope: 'tenant', tenantId: tA, name: 'a' });
    const platform = registry.createKnowledgeSource({ scope: 'platform', name: 'p' });
    registry.createMount({
      tenantId: tA,
      consumerType: 'agent',
      consumerId: 'agent-1',
      sourceType: 'knowledge',
      sourceId: src.sourceId,
    });

    expect(() =>
      registry.deleteKnowledgeSource({ sourceId: src.sourceId, viewerTenantId: tB, isPlatformAdmin: false }),
    ).toThrow(/cross_tenant/);
    expect(() =>
      registry.deleteKnowledgeSource({ sourceId: platform.sourceId, viewerTenantId: tA, isPlatformAdmin: false }),
    ).toThrow(/forbidden/);
    expect(
      registry.deleteKnowledgeSource({ sourceId: src.sourceId, viewerTenantId: tA, isPlatformAdmin: false }),
    ).toBe(true);
    expect(registry.listMounts({ tenantId: tA, sourceId: src.sourceId })).toEqual([]);
  });

  it('mounts：agentRef（session 挂载必填）/ listMounts 过滤 / deleteMount 租户收口', () => {
    const src = registry.createKnowledgeSource({ scope: 'tenant', tenantId: tA, name: 'a' });
    expect(() =>
      registry.createMount({
        tenantId: tA,
        consumerType: 'session',
        consumerId: 'sess-1',
        sourceType: 'knowledge',
        sourceId: src.sourceId,
      }),
    ).toThrow(/agent_ref/);

    const m = registry.createMount({
      tenantId: tA,
      consumerType: 'session',
      consumerId: 'sess-1',
      sourceType: 'knowledge',
      sourceId: src.sourceId,
      agentRef: 'agent-9',
    });
    expect(m.agentRef).toBe('agent-9');
    expect(registry.getMount(m.mountId)?.agentRef).toBe('agent-9');

    const m2 = registry.createMount({
      tenantId: tA,
      consumerType: 'agent',
      consumerId: 'agent-1',
      sourceType: 'knowledge',
      sourceId: src.sourceId,
    });
    expect(registry.listMounts({ tenantId: tA, consumerType: 'agent' })).toEqual([
      expect.objectContaining({ mountId: m2.mountId }),
    ]);

    expect(() => registry.deleteMount({ mountId: m.mountId, tenantId: tB })).toThrow(/cross_tenant/);
    expect(registry.deleteMount({ mountId: m.mountId, tenantId: tA })).toBe(true);
    expect(registry.getMount(m.mountId as MountId)).toBeNull();
  });
});

describe('WebApiRouter /registry/knowledge-sources + /registry/mounts（HTTP 面）', () => {
  let registry: RegistryService;
  let router: WebApiRouter;
  let log: Array<{ op: string; args: unknown[] }>;
  let aliceToken: string;

  beforeEach(async () => {
    registry = await RegistryService.create({ dbPath: ':memory:' });
    log = [];
    const stub = {
      getRegistry: () => registry,
      attachRegistryAgent: async () => true,
      detachRegistryAgent: () => {},
      getKnowledgeClient: async () => fakeKnowledgeClient(log),
    };
    router = new WebApiRouter({ gateway: stub as unknown as Gateway });
    const reg = await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'alice' } });
    aliceToken = (reg.body?.data as { token: string }).token;
  });
  afterEach(() => registry.close());

  it('POST knowledge-sources：知识面建档（带归属断言）→ 所有权登记（sourceId 链接）', async () => {
    const res = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/knowledge-sources',
      token: aliceToken,
      body: { name: 'team-docs', kind: 'directory', location: '/tmp/team' },
    });
    expect(res.status).toBe(201);
    const data = res.body?.data as { sourceId: string; scope: string; tenantId: string };
    expect(data.scope).toBe('tenant');

    // 物化先于定义：知识面建档带归属断言（v0.113.10 写域护栏口径）
    const create = log.find((l) => l.op === 'createSource');
    expect(create).toBeDefined();
    const [, opts] = create!.args as [Record<string, unknown>, { tenantId: string }];
    expect(opts.tenantId).toBe(data.tenantId);
    expect(data.sourceId).toBe('ks_1');
  });

  it('POST knowledge-sources scope=platform：非 admin 403（alice=首注册=admin，用 bob 验）', async () => {
    const bob = await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'bob' } });
    const bobToken = (bob.body?.data as { token: string }).token;
    const res = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/knowledge-sources',
      token: bobToken,
      body: { name: 'pub', location: '/tmp/pub', scope: 'platform' },
    });
    expect(res.status).toBe(403);
    expect(log).toEqual([]);
  });

  it('DELETE knowledge-sources：先撤执法行再删定义（少可见方向）', async () => {
    const created = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/knowledge-sources',
      token: aliceToken,
      body: { name: 'team-docs', location: '/tmp/team' },
    });
    const sourceId = (created.body?.data as { sourceId: string }).sourceId;
    log.length = 0;

    const res = await call(router, {
      method: 'DELETE',
      url: `/api/v1/registry/knowledge-sources/${sourceId}`,
      token: aliceToken,
    });
    expect(res.status).toBe(200);
    expect(log.map((l) => l.op)).toEqual(['deleteSource']);
    expect(registry.getKnowledgeSource(sourceId)).toBeNull();
  });

  it('POST mounts（agent）：物化 setAgentVisibility；物化失败补偿撤记录', async () => {
    const created = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/knowledge-sources',
      token: aliceToken,
      body: { name: 'team-docs', location: '/tmp/team' },
    });
    const sourceId = (created.body?.data as { sourceId: string }).sourceId;
    log.length = 0;

    const res = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/mounts',
      token: aliceToken,
      body: { consumerType: 'agent', consumerId: 'agent-1', sourceId },
    });
    expect(res.status).toBe(201);
    expect(log.map((l) => l.op)).toEqual(['setAgentVisibility']);
    expect(registry.listMounts({ tenantId: (created.body?.data as { tenantId: TenantId }).tenantId })).toHaveLength(1);

    // 补偿：物化失败 → 挂载记录不留下
    const failing = {
      getRegistry: () => registry,
      attachRegistryAgent: async () => true,
      detachRegistryAgent: () => {},
      getKnowledgeClient: async () => ({
        ...fakeKnowledgeClient(log),
        setAgentVisibility: async () => {
          throw new Error('materialize boom');
        },
      }),
    };
    const badRouter = new WebApiRouter({ gateway: failing as unknown as Gateway });
    const res2 = await call(badRouter, {
      method: 'POST',
      url: '/api/v1/registry/mounts',
      token: aliceToken,
      body: { consumerType: 'agent', consumerId: 'agent-2', sourceId },
    });
    expect(res2.status).toBe(500);
    const mounts = registry.listMounts({
      tenantId: (created.body?.data as { tenantId: TenantId }).tenantId,
      consumerId: 'agent-2',
    });
    expect(mounts).toEqual([]);
  });

  it('POST mounts（project）→ 501 not_implemented（fail-loud，不做假成功）', async () => {
    const res = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/mounts',
      token: aliceToken,
      body: { consumerType: 'project', consumerId: 'p1', sourceId: 'ks_x' },
    });
    expect(res.status).toBe(501);
  });

  it('POST/DELETE mounts（session，HTTP seam）：agentRef 反物化锚 + op 级撤（MAJ-1/2 锚）', async () => {
    const created = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/knowledge-sources',
      token: aliceToken,
      body: { name: 'team-docs', location: '/tmp/team' },
    });
    const sourceId = (created.body?.data as { sourceId: string }).sourceId;
    const tenantId = (created.body?.data as { tenantId: TenantId }).tenantId;
    log.length = 0;

    // MAJ-1 锚：session 挂载 HTTP 面全链（此前 body.agentId 校验了却漏传 → 恒 400）
    const res = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/mounts',
      token: aliceToken,
      body: { consumerType: 'session', consumerId: 'sess-1', sourceId, agentId: 'agent-9' },
    });
    expect(res.status).toBe(201);
    const mountId = (res.body?.data as { mountId: string }).mountId;
    expect((res.body?.data as { agentRef: string }).agentRef).toBe('agent-9');
    expect(log.map((l) => l.op)).toEqual(['setSessionVisibility']);

    // 反物化：op=include 级 clear（不误删用户显式 deny）+ 用 agentRef
    log.length = 0;
    const del = await call(router, {
      method: 'DELETE',
      url: `/api/v1/registry/mounts/${mountId}`,
      token: aliceToken,
    });
    expect(del.status).toBe(200);
    expect(log.map((l) => l.op)).toEqual(['clearSessionVisibility']);
    const clearArgs = log[0].args as [string, string, unknown, unknown, string];
    expect(clearArgs[0]).toBe('agent-9');
    expect(clearArgs[4]).toBe('include');

    // MAJ-2 锚：agentRef 缺失 = 拒删（fail-loud，不留下不可撤的 include 行）
    const direct = registry.createMount({
      tenantId,
      consumerType: 'session',
      consumerId: 'sess-2',
      sourceType: 'knowledge',
      sourceId,
      agentRef: 'agent-9',
    });
    // 模拟 legacy 行（无 API 清 agent_ref）——走私有 db 面仅限本测试
    (registry as unknown as { db: { raw: { prepare(sql: string): { run(id: string): void } } } }).db.raw
      .prepare('UPDATE mounts SET agent_ref = NULL WHERE mount_id = ?')
      .run(direct.mountId);
    log.length = 0;
    const del2 = await call(router, {
      method: 'DELETE',
      url: `/api/v1/registry/mounts/${direct.mountId}`,
      token: aliceToken,
    });
    expect(del2.status).toBe(409);
    expect(log).toEqual([]); // 未动执法、未删定义
    expect(registry.getMount(direct.mountId)).not.toBeNull();
  });

  it('DELETE mounts（agent）：先撤执法（unmount/clear）再删记录', async () => {
    const created = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/knowledge-sources',
      token: aliceToken,
      body: { name: 'team-docs', location: '/tmp/team' },
    });
    const sourceId = (created.body?.data as { sourceId: string }).sourceId;
    const mounted = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/mounts',
      token: aliceToken,
      body: { consumerType: 'agent', consumerId: 'agent-1', sourceId },
    });
    const mountId = (mounted.body?.data as { mountId: string }).mountId;
    log.length = 0;

    const res = await call(router, {
      method: 'DELETE',
      url: `/api/v1/registry/mounts/${mountId}`,
      token: aliceToken,
    });
    expect(res.status).toBe(200);
    expect(log.map((l) => l.op)).toEqual(['setAgentVisibility']);
    expect((log[0].args as [string, string])[1]).toBe('unmount');
    expect(registry.getMount(mountId as MountId)).toBeNull();
  });
});
