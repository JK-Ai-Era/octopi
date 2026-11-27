/**
 * 控制台知识管理 HTTP 面的写归属与授权（arch/multi-tenancy.md §6 写归属，2026-11-28 拍板：
 * 用户建的项目/源默认挂用户所属租户）——
 * - 建/改/删项目与源：X-Registry-Token 在场按用户租户传归属；无头 = host 面 DEFAULT 存量域
 * - 公共项目 = platform 共享面资产，仅 host 面/平台 admin（复选框暂缓，API 同边界）
 * - session overlay 写路由归属闸：registry 托管 agent 不得跨租户改（与建会话同口径 403）
 * - 读口收口（R2）：token 在场按身份收口（admin/host = platform 全量，普通用户 = 本租户）
 * - 写错误映射（R6）：归属越权 403 / not found 404，不拍平成 500
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebApiRouter } from '@octopi-agent/gateway/web/api/router.js';
import type { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { RegistryService } from '@octopi-agent/engine/harness/governance/registry/service.js';
import { DEFAULT_TENANT_ID, PLATFORM_TENANT_ID } from '@octopi-agent/core/types.js';

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

describe('WebApiRouter 知识管理写归属（HTTP 面）', () => {
  let registry: RegistryService;
  let router: WebApiRouter;
  let aliceToken: string;
  let bobToken: string;
  let aliceTenant: string;
  let bobTenant: string;
  let calls: Array<{ method: string; args: unknown[] }>;
  let failWith: string | null;

  beforeEach(async () => {
    registry = await RegistryService.create({ dbPath: ':memory:' });
    calls = [];
    failWith = null;
    const record =
      (method: string, result?: unknown) =>
      (...args: unknown[]): Promise<unknown> => {
        calls.push({ method, args });
        if (failWith) return Promise.reject(new Error(failWith));
        return Promise.resolve(result);
      };
    const stub = {
      getRegistry: () => registry,
      attachRegistryAgent: async () => true,
      detachRegistryAgent: () => {},
      createKnowledgeProject: record('createKnowledgeProject'),
      createKnowledgeSource: record('createKnowledgeSource', { id: 's1' }),
      updateKnowledgeSource: record('updateKnowledgeSource', { id: 's1', name: 'n' }),
      removeKnowledgeSource: record('removeKnowledgeSource', true),
      removeKnowledgeProject: record('removeKnowledgeProject', true),
      setKnowledgeSessionVisibility: record('setKnowledgeSessionVisibility'),
      replaceKnowledgeSessionVisibility: record('replaceKnowledgeSessionVisibility'),
      clearKnowledgeSessionVisibility: record('clearKnowledgeSessionVisibility'),
      listKnowledgeProjects: record('listKnowledgeProjects', []),
      listKnowledgeSources: record('listKnowledgeSources', []),
      searchKnowledge: record('searchKnowledge', {
        usedVector: false,
        coverage: 0,
        keywordHits: 0,
        vectorHits: 0,
        hits: [],
      }),
      getKnowledgeSessionVisibility: record('getKnowledgeSessionVisibility', []),
    };
    router = new WebApiRouter({ gateway: stub as unknown as Gateway });
    const regA = await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'alice' } });
    aliceToken = (regA.body?.data as { token: string }).token;
    aliceTenant = registry.resolveToken(aliceToken)?.tenantId ?? '';
    const regB = await call(router, { method: 'POST', url: '/api/v1/registry/register', body: { name: 'bob' } });
    bobToken = (regB.body?.data as { token: string }).token;
    bobTenant = registry.resolveToken(bobToken)?.tenantId ?? '';
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

  it('建项目：有身份=用户租户，无身份=host 面 DEFAULT；坏凭证 401', async () => {
    const asBob = await call(router, {
      method: 'POST',
      url: '/api/v1/agents/a1/knowledge/projects',
      token: bobToken,
      body: { projectKey: 'p-bob' },
    });
    expect(asBob.status).toBe(201);
    expect(calls.pop()).toEqual({
      method: 'createKnowledgeProject',
      args: ['p-bob', undefined, undefined, bobTenant],
    });

    const asHost = await call(router, {
      method: 'POST',
      url: '/api/v1/agents/a1/knowledge/projects',
      body: { projectKey: 'p-host' },
    });
    expect(asHost.status).toBe(201);
    expect(calls.pop()).toEqual({
      method: 'createKnowledgeProject',
      args: ['p-host', undefined, undefined, DEFAULT_TENANT_ID],
    });

    const bad = await call(router, {
      method: 'POST',
      url: '/api/v1/agents/a1/knowledge/projects',
      token: 'not-a-token',
      body: { projectKey: 'p-bad' },
    });
    expect(bad.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('公共项目仅 host 面/平台 admin：bob 拒 403，alice（首注册=admin）与 host 放行', async () => {
    const bob = await call(router, {
      method: 'POST',
      url: '/api/v1/agents/a1/knowledge/projects',
      token: bobToken,
      body: { projectKey: 'p-pub', visibility: 'public' },
    });
    expect(bob.status).toBe(403);
    expect(bob.body?.error).toMatch(/registry_forbidden/);

    const alice = await call(router, {
      method: 'POST',
      url: '/api/v1/agents/a1/knowledge/projects',
      token: aliceToken,
      body: { projectKey: 'p-pub', visibility: 'public' },
    });
    expect(alice.status).toBe(201);
    expect(calls.pop()).toEqual({
      method: 'createKnowledgeProject',
      args: ['p-pub', undefined, 'public', aliceTenant],
    });

    const host = await call(router, {
      method: 'POST',
      url: '/api/v1/agents/a1/knowledge/projects',
      body: { projectKey: 'p-pub2', visibility: 'public' },
    });
    expect(host.status).toBe(201);
  });

  it('建/改/删源与删项目：writer 身份整体下传（租户 + 是否平台 admin）', async () => {
    const sourceBody = {
      kind: 'file',
      location: '/tmp/x.md',
      scopeRef: { level: 'global', key: 'g1' },
    };
    const bobWriter = { tenantId: bobTenant, isPlatformAdmin: false };

    const created = await call(router, {
      method: 'POST',
      url: '/api/v1/agents/a1/knowledge/sources',
      token: bobToken,
      body: sourceBody,
    });
    expect(created.status).toBe(201);
    expect(calls.pop()).toEqual({
      method: 'createKnowledgeSource',
      args: [sourceBody, bobWriter],
    });

    await call(router, {
      method: 'PATCH',
      url: '/api/v1/agents/a1/knowledge/sources/s1',
      token: bobToken,
      body: { name: 'n' },
    });
    expect(calls.pop()).toEqual({
      method: 'updateKnowledgeSource',
      args: ['s1', { name: 'n' }, bobWriter],
    });

    await call(router, {
      method: 'DELETE',
      url: '/api/v1/agents/a1/knowledge/sources/s1',
      token: bobToken,
    });
    expect(calls.pop()).toEqual({ method: 'removeKnowledgeSource', args: ['s1', bobWriter] });

    await call(router, {
      method: 'DELETE',
      url: '/api/v1/agents/a1/knowledge/projects/p1',
      token: bobToken,
    });
    expect(calls.pop()).toEqual({ method: 'removeKnowledgeProject', args: ['p1', bobWriter] });
  });

  it('写错误映射（R6）：归属越权 403 / not found 404，不拍平成 500', async () => {
    failWith = 'not source owner';
    const forbidden = await call(router, {
      method: 'DELETE',
      url: '/api/v1/agents/a1/knowledge/sources/s1',
      token: bobToken,
    });
    expect(forbidden.status).toBe(403);

    failWith = 'source not found';
    const missing = await call(router, {
      method: 'DELETE',
      url: '/api/v1/agents/a1/knowledge/sources/s1',
      token: bobToken,
    });
    expect(missing.status).toBe(404);
  });

  it('session overlay 写路由归属闸：跨租户 registry agent 403；本租户/平台 admin 放行', async () => {
    const agentA = await createAgent(aliceToken, 'agent-a');
    calls.length = 0;

    const cross = await call(router, {
      method: 'POST',
      url: `/api/v1/agents/${agentA}/knowledge/session-visibility`,
      token: bobToken,
      body: { sessionId: 's-1', targetType: 'project', targetId: 'p1', op: 'include' },
    });
    expect(cross.status).toBe(403);
    expect(cross.body?.error).toMatch(/registry_cross_tenant_agent/);
    expect(calls).toHaveLength(0);

    const own = await call(router, {
      method: 'POST',
      url: `/api/v1/agents/${agentA}/knowledge/session-visibility`,
      token: aliceToken,
      body: { sessionId: 's-1', targetType: 'project', targetId: 'p1', op: 'include' },
    });
    expect(own.status).toBe(200);
    expect(calls.pop()?.method).toBe('setKnowledgeSessionVisibility');

    const asHost = await call(router, {
      method: 'DELETE',
      url: `/api/v1/agents/${agentA}/knowledge/session-visibility?sessionId=s-1`,
    });
    expect(asHost.status).toBe(200);
    expect(calls.pop()?.method).toBe('clearKnowledgeSessionVisibility');
  });

  it('读口收口（R2）：普通用户=本租户，admin/host=platform 全量视图', async () => {
    await call(router, { method: 'GET', url: '/api/v1/agents/a1/knowledge/projects', token: bobToken });
    expect(calls.pop()).toEqual({ method: 'listKnowledgeProjects', args: [bobTenant] });

    await call(router, { method: 'GET', url: '/api/v1/agents/a1/knowledge/projects', token: aliceToken });
    expect(calls.pop()).toEqual({ method: 'listKnowledgeProjects', args: [PLATFORM_TENANT_ID] });

    await call(router, { method: 'GET', url: '/api/v1/agents/a1/knowledge/projects' });
    expect(calls.pop()).toEqual({ method: 'listKnowledgeProjects', args: [PLATFORM_TENANT_ID] });

    await call(router, {
      method: 'GET',
      url: '/api/v1/agents/a1/knowledge/search?q=hello',
      token: bobToken,
    });
    expect(calls.pop()).toMatchObject({
      method: 'searchKnowledge',
      args: ['hello', { agentId: 'a1', readTenantId: bobTenant }],
    });

    await call(router, {
      method: 'GET',
      url: '/api/v1/agents/a1/knowledge/session-visibility?sessionId=s-1',
      token: bobToken,
    });
    expect(calls.pop()).toEqual({
      method: 'getKnowledgeSessionVisibility',
      args: ['a1', 's-1', bobTenant],
    });
  });
});
