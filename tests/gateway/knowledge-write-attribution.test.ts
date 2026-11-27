/**
 * 控制台知识管理写路径的写者归属与授权（arch/multi-tenancy.md §6 写归属，2026-11-28 拍板：
 * 用户建的项目/源默认挂用户所属租户）——
 * - 创建/更新/删除按写者租户断言；公共项目恒 platform 共享面
 * - project 级源的域继承带授权（评审 R1）：不冒用他域 claim，platform 项目仅平台 admin
 * - 管理写域与调用者域拆开（评审 R3）：admin/host 按目标行归属域（运维豁免不丢）
 * - 删项目诚实回报 removed（评审 R7）；overlay replace 带 legacy 残行补偿（评审 R8）
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCanonicalLocation } from '@octopi-agent/engine/harness/knowledge/location.js';
import { DEFAULT_TENANT_ID, PLATFORM_TENANT_ID } from '@octopi-agent/core/types.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';

type Call = { method: string; args: unknown[] };

function makeGateway(opts?: {
  agentTenants?: Record<string, string>;
  projects?: Record<string, { tenantId: string }>;
  sources?: Record<string, { tenantId: string }>;
  deleteProjectResult?: { removed?: boolean };
}): { gateway: Gateway; calls: Call[] } {
  const calls: Call[] = [];
  const projects = opts?.projects ?? {};
  const sources = opts?.sources ?? {};
  const record =
    (method: string, result?: unknown) =>
    (...args: unknown[]): Promise<unknown> => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  const client = {
    createProject: record('createProject'),
    createSource: record('createSource'),
    patchSource: record('patchSource'),
    deleteSource: record('deleteSource'),
    deleteProject: record('deleteProject', opts?.deleteProjectResult ?? { removed: true }),
    setSessionVisibility: record('setSessionVisibility'),
    replaceSessionVisibility: record('replaceSessionVisibility'),
    clearSessionVisibility: record('clearSessionVisibility'),
    listProjects: record('listProjects', []),
    listSources: record('listSources', []),
    search: record('search', { hits: [], keywordHits: 0, vectorHits: 0 }),
    sessionVisibility: record('sessionVisibility', []),
    ensurePrincipal: record('ensurePrincipal'),
    getProject: (key: string, o?: { tenantId?: string }) => {
      calls.push({ method: 'getProject', args: [key, o] });
      return Promise.resolve(projects[key] ?? null);
    },
    getSource: (id: string) => Promise.resolve(sources[id] ?? null),
  };
  const gateway = new Gateway(
    { agents: [], knowledge: { service: { manageLocal: false } } },
    new InMemorySessionStore(),
  );
  // 测试缝：注入 registry 归属表与知识客户端（生产由 start()/GatewayKnowledgeRuntime 接线）
  const g = gateway as unknown as {
    registry: { getAgent: (id: string) => { tenantId: string } | null };
    getKnowledgeClient: () => Promise<unknown>;
  };
  const agentTenants = opts?.agentTenants ?? {};
  g.registry = {
    getAgent: (id) => (agentTenants[id] !== undefined ? { tenantId: agentTenants[id]! } : null),
  };
  g.getKnowledgeClient = async () => client;
  return { gateway, calls };
}

const ADMIN = { tenantId: 'admin-tenant', isPlatformAdmin: true };
const ACME = { tenantId: 'acme', isPlatformAdmin: false };

describe('知识创建链写者归属（§6：用户建的项目/源落用户所属租户）', () => {
  it('建项目落写者租户；public 恒 platform 共享面；无写者=存量默认（兼容旧调用）', async () => {
    const { gateway, calls } = makeGateway();

    await gateway.createKnowledgeProject('p1', 'P1', undefined, 'acme');
    expect(calls.pop()).toEqual({
      method: 'createProject',
      args: [{ projectKey: 'p1', displayName: 'P1', visibility: undefined }, 'acme'],
    });

    await gateway.createKnowledgeProject('p2', undefined, 'public', 'acme');
    expect(calls.pop()).toEqual({
      method: 'createProject',
      args: [{ projectKey: 'p2', displayName: undefined, visibility: 'public' }, PLATFORM_TENANT_ID],
    });

    await gateway.createKnowledgeProject('p3');
    expect(calls.pop()).toEqual({
      method: 'createProject',
      args: [{ projectKey: 'p3', displayName: undefined, visibility: undefined }, undefined],
    });
  });

  it('建源落写者租户；project 级源继承项目登记行归属域（M1）', async () => {
    const { gateway, calls } = makeGateway({
      projects: { 'p-owned': { tenantId: 'acme' } },
    });
    const input = {
      kind: 'file',
      location: '/data/x.md',
      scopeRef: { level: 'global', key: 'g1' },
    } as never;

    await gateway.createKnowledgeSource(input, ACME);
    expect(calls.pop()).toEqual({
      method: 'createSource',
      args: [input, { tenantId: 'acme' }],
    });

    const projectInput = {
      kind: 'file',
      location: '/data/y.md',
      scopeRef: { level: 'project', key: 'p-owned' },
    } as never;
    await gateway.createKnowledgeSource(projectInput, ACME);
    expect(calls.pop()).toEqual({
      method: 'createSource',
      args: [projectInput, { tenantId: 'acme' }],
    });
  });

  it('域继承带授权（R1）：读不到的项目 fail-loud，platform 项目仅平台 admin，绝不冒用他域 claim', async () => {
    // 他域私有/不存在 → getProject 按写者身份解析为 null（服务端语义），fail-loud
    const foreign = makeGateway({ projects: {} });
    const pInput = {
      kind: 'file',
      location: '/tmp/z.md',
      scopeRef: { level: 'project', key: 'p-foreign' },
    } as never;
    await expect(foreign.gateway.createKnowledgeSource(pInput, ACME)).rejects.toThrow(
      /knowledge_project_not_found/,
    );
    expect(foreign.calls.filter((c) => c.method === 'createSource')).toHaveLength(0);

    // platform 公共项目：普通用户拒，平台 admin 可写且落 platform 域
    const pub = makeGateway({ projects: { 'p-pub': { tenantId: PLATFORM_TENANT_ID } } });
    const pubInput = {
      kind: 'file',
      location: '/data/pub.md',
      scopeRef: { level: 'project', key: 'p-pub' },
    } as never;
    await expect(pub.gateway.createKnowledgeSource(pubInput, ACME)).rejects.toThrow(
      /registry_forbidden/,
    );
    await pub.gateway.createKnowledgeSource(pubInput, ADMIN);
    expect(pub.calls.pop()).toEqual({
      method: 'createSource',
      args: [pubInput, { tenantId: PLATFORM_TENANT_ID }],
    });
  });

  it('管理写域与调用者域拆开（R3）：admin 按目标行域（运维豁免不丢），普通用户按本域', async () => {
    const { gateway, calls } = makeGateway({
      sources: { 's-tenant': { tenantId: 'acme' }, 's-pub': { tenantId: PLATFORM_TENANT_ID } },
    });

    // 普通用户：断言本域（服务端 assertSourceWritable 把关归属）
    await gateway.updateKnowledgeSource('s-tenant', { name: 'n' } as never, ACME);
    expect(calls.pop()).toEqual({
      method: 'patchSource',
      args: ['s-tenant', { name: 'n' }, { tenantId: 'acme' }],
    });

    // 平台 admin：按目标行归属域（可管租户/公共资产）
    await gateway.updateKnowledgeSource('s-tenant', { name: 'n' } as never, ADMIN);
    expect(calls.pop()).toEqual({
      method: 'patchSource',
      args: ['s-tenant', { name: 'n' }, { tenantId: 'acme' }],
    });
    await gateway.removeKnowledgeSource('s-pub', ADMIN);
    expect(calls.pop()).toEqual({
      method: 'deleteSource',
      args: ['s-pub', { tenantId: PLATFORM_TENANT_ID }],
    });
    await gateway.removeKnowledgeProject('p-any', ADMIN);
    expect(calls.pop()).toEqual({ method: 'deleteProject', args: ['p-any', { tenantId: DEFAULT_TENANT_ID }] });
  });

  it('删项目诚实回报 removed（R7）：不存在/跨域 = false，不假报成功', async () => {
    const { gateway } = makeGateway({ deleteProjectResult: { removed: false } });
    await expect(gateway.removeKnowledgeProject('p-missing', ACME)).resolves.toBe(false);

    const ok = makeGateway({ deleteProjectResult: { removed: true } });
    await expect(ok.gateway.removeKnowledgeProject('p1', ACME)).resolves.toBe(true);
  });

  it('overlay set/replace 按目标 agent 归属域断言；replace 带 legacy 残行补偿（R8）', async () => {
    const { gateway, calls } = makeGateway({ agentTenants: { 'a1': 'acme' } });
    const item = { targetType: 'project', targetId: 'p1', op: 'include' } as never;

    await gateway.setKnowledgeSessionVisibility('a1', 's-1', item);
    expect(calls.pop()).toEqual({
      method: 'setSessionVisibility',
      args: ['a1', { sessionId: 's-1', targetType: 'project', targetId: 'p1', op: 'include' }, { tenantId: 'acme' }],
    });

    await gateway.replaceKnowledgeSessionVisibility('a1', 's-1', [item]);
    expect(calls.map((c) => c.method)).toEqual(['replaceSessionVisibility', 'clearSessionVisibility']);
    expect(calls[0]!.args[3]).toEqual({ tenantId: 'acme' });
    expect((calls[1]!.args[3] as { tenantId?: string }).tenantId).toEqual(DEFAULT_TENANT_ID);
  });

  it('overlay clear 带 legacy 残行补偿：非 default 归属双域清，default 归属单次', async () => {
    const { gateway, calls } = makeGateway({ agentTenants: { 'a1': 'acme' } });

    await gateway.clearKnowledgeSessionVisibility('a1', 's-1');
    expect(calls.map((c) => (c.args[3] as { tenantId?: string }).tenantId)).toEqual([
      'acme',
      DEFAULT_TENANT_ID,
    ]);

    calls.length = 0;
    await gateway.clearKnowledgeSessionVisibility('legacy-1', 's-1');
    expect(calls.map((c) => (c.args[3] as { tenantId?: string }).tenantId)).toEqual([
      DEFAULT_TENANT_ID,
    ]);
  });

  it('R5 location 围栏：普通写者内部态路径拒（knowledge_location_forbidden），admin 豁免', async () => {
    const prevHome = process.env.OCTOPI_HOME;
    const home = mkdtempSync(join(tmpdir(), 'octopi-gw-fence-'));
    mkdirSync(join(home, 'sessions'), { recursive: true });
    process.env.OCTOPI_HOME = home;
    try {
      const { gateway } = makeGateway();
      const internal = {
        kind: 'directory',
        location: join(home, 'sessions'),
        scopeRef: { level: 'global', key: 'global' },
      } as never;
      await expect(gateway.createKnowledgeSource(internal, ACME)).rejects.toThrow(
        /knowledge_location_forbidden/,
      );
      await gateway.createKnowledgeSource(internal, ADMIN); // 豁免（运维口子）
    } finally {
      if (prevHome === undefined) delete process.env.OCTOPI_HOME;
      else process.env.OCTOPI_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('R5 围栏覆盖改 location（评审 BLOCKER-1）：PATCH 内部态拒；裁决 canonical 落库（MAJOR-5）', async () => {
    const prevHome = process.env.OCTOPI_HOME;
    const home = mkdtempSync(join(tmpdir(), 'octopi-gw-patch-fence-'));
    mkdirSync(join(home, 'sessions'), { recursive: true });
    process.env.OCTOPI_HOME = home;
    const outside = mkdtempSync(join(tmpdir(), 'octopi-gw-patch-ok-'));
    try {
      const { gateway, calls } = makeGateway({ sources: { 'ks1': { tenantId: 'acme' } } });

      // 越权链（评审原文）：普通租户用户 PATCH location 到内部态 → 拒，且不得落库
      await expect(
        gateway.updateKnowledgeSource('ks1', { location: join(home, 'sessions') }, ACME),
      ).rejects.toThrow(/knowledge_location_forbidden/);
      expect(calls.filter((c) => c.method === 'patchSource')).toHaveLength(0);

      // 合法改 location：落库形态 = 围栏裁决的 canonical
      await gateway.updateKnowledgeSource('ks1', { location: join(outside, 'docs') }, ACME);
      const call = calls.find((c) => c.method === 'patchSource');
      expect(call).toBeTruthy();
      expect((call!.args[1] as { location: string }).location).toBe(
        resolveCanonicalLocation(join(outside, 'docs')),
      );

      // admin 豁免（运维口子）照旧
      await gateway.updateKnowledgeSource('ks1', { location: join(home, 'sessions') }, ADMIN);
      expect(calls.filter((c) => c.method === 'patchSource')).toHaveLength(2);
    } finally {
      if (prevHome === undefined) delete process.env.OCTOPI_HOME;
      else process.env.OCTOPI_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('读口收口（R2）：列表/检索/overlay 读透传读身份', async () => {
    const { gateway, calls } = makeGateway({ agentTenants: { 'a1': 'acme' } });

    await gateway.listKnowledgeProjects('acme');
    expect(calls.pop()).toEqual({ method: 'listProjects', args: [{ tenantId: 'acme' }] });

    await gateway.listKnowledgeSources('a1', { scopeLevel: 'global' }, 'acme');
    expect(calls.pop()).toEqual({
      method: 'listSources',
      args: [{ scopeLevel: 'global', tenantId: 'acme' }],
    });

    await gateway.searchKnowledge('q', { agentId: 'a1', readTenantId: 'acme' });
    expect(calls.pop()).toEqual({
      method: 'search',
      args: ['a1', 'q', { sessionId: undefined, limit: undefined, tenantId: 'acme' }],
    });

    await gateway.getKnowledgeSessionVisibility('a1', 's-1', 'acme');
    expect(calls.pop()).toEqual({
      method: 'sessionVisibility',
      args: ['a1', 's-1', { tenantId: 'acme' }],
    });
  });
});
