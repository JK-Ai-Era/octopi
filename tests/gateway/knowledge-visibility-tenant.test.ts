/**
 * gateway.setKnowledgeVisibility 的租户断言接线（arch/multi-tenancy.md §6，T3c）。
 *
 * 写域 = 目标 agent 归属租户（registry 是归属权威；非 registry agent = 存量 default 域）。
 * 撤销（unassign/unhide）对非 default 归属 agent 追加一次 DEFAULT 域残行补偿——
 * 断言收口前的管理面写入曾落 DEFAULT 域，残行会让复选框「取消不掉」；补偿失败不翻转主操作。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TENANT_ID } from '@octopi-agent/core/types.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import { startKnowledgeService } from '@octopi-agent/engine/harness/knowledge/serve.js';
import { KnowledgeClient } from '@octopi-agent/engine/harness/knowledge/client.js';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';

type VisCall = {
  agentId: string;
  op: string;
  body: { projectKey?: string; sourceId?: string };
  tenantId: string | undefined;
};

function makeGateway(
  agentTenants: Record<string, string>,
  realClient?: KnowledgeClient,
): { gateway: Gateway; calls: VisCall[] } {
  const calls: VisCall[] = [];
  const client = realClient ?? {
    visibility: async (
      agentId: string,
      op: string,
      body: { projectKey?: string; sourceId?: string },
      opts?: { tenantId?: string },
    ): Promise<void> => {
      calls.push({ agentId, op, body, tenantId: opts?.tenantId });
    },
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
  g.registry = {
    getAgent: (id) => (agentTenants[id] !== undefined ? { tenantId: agentTenants[id]! } : null),
  };
  g.getKnowledgeClient = async () => client;
  return { gateway, calls };
}

describe('setKnowledgeVisibility 租户断言（T3c）', () => {
  it('写入按 registry 归属租户断言；非 registry agent 落存量 default 域', async () => {
    const { gateway, calls } = makeGateway({ 'a1': 'acme' });

    await gateway.setKnowledgeVisibility({
      op: 'assignProject',
      agentId: 'a1',
      projectKey: 'p1',
    });
    expect(calls).toEqual([
      { agentId: 'a1', op: 'assignProject', body: { projectKey: 'p1', sourceId: undefined }, tenantId: 'acme' },
    ]);

    calls.length = 0;
    await gateway.setKnowledgeVisibility({
      op: 'assignProject',
      agentId: 'legacy-1',
      projectKey: 'p1',
    });
    expect(calls).toEqual([
      {
        agentId: 'legacy-1',
        op: 'assignProject',
        body: { projectKey: 'p1', sourceId: undefined },
        tenantId: DEFAULT_TENANT_ID,
      },
    ]);
  });

  it('撤销对非 default 归属 agent 追加 DEFAULT 域残行补偿；default 归属不重复', async () => {
    const { gateway, calls } = makeGateway({ 'a1': 'acme' });

    await gateway.setKnowledgeVisibility({
      op: 'unassignProject',
      agentId: 'a1',
      projectKey: 'p1',
    });
    expect(calls.map((c) => c.tenantId)).toEqual(['acme', DEFAULT_TENANT_ID]);

    calls.length = 0;
    await gateway.setKnowledgeVisibility({
      op: 'unassignProject',
      agentId: 'legacy-1',
      projectKey: 'p1',
    });
    expect(calls.map((c) => c.tenantId)).toEqual([DEFAULT_TENANT_ID]);
  });

  it('hide/unhide 与挂载同规则：hide 单次按域写，unhide 带残行补偿', async () => {
    const { gateway, calls } = makeGateway({ 'a1': 'acme' });

    await gateway.setKnowledgeVisibility({ op: 'hide', agentId: 'a1', sourceId: 's1' });
    expect(calls.map((c) => c.tenantId)).toEqual(['acme']);

    calls.length = 0;
    await gateway.setKnowledgeVisibility({ op: 'unhide', agentId: 'a1', sourceId: 's1' });
    expect(calls.map((c) => c.tenantId)).toEqual(['acme', DEFAULT_TENANT_ID]);
  });

  it('全链路：真实 client 打真服务——断言头经 gateway→client→service 上行（跨域 assign 被拒即证）', async () => {
    const svc = await startKnowledgeService({
      dbPath: ':memory:',
      port: 0,
      tokens: [{ token: 't1', tenantId: 'platform', gatewayId: 'gw1' }],
      autoRegisterPrincipals: true,
    });
    const client = new KnowledgeClient({
      baseUrl: `http://127.0.0.1:${svc.port}`,
      token: 't1',
      timeoutMs: 5000,
    });
    try {
      const { gateway } = makeGateway({ 'a1': 'acme' }, client);
      // p-def 落 DEFAULT 域（无断言）；p-acme 落 acme 域
      await client.createProject({ projectKey: 'p-def', visibility: 'private' });
      await client.createProject({ projectKey: 'p-acme', visibility: 'private' }, 'acme');

      // 若断言头未随真实 client 上行，写身份会降级 DEFAULT 而假成功——拒绝即证明上行成立
      await expect(
        gateway.setKnowledgeVisibility({ op: 'assignProject', agentId: 'a1', projectKey: 'p-def' }),
      ).rejects.toThrow(/not visible to writer/);

      // 同租户挂载经全链路成功且回显
      await gateway.setKnowledgeVisibility({
        op: 'assignProject',
        agentId: 'a1',
        projectKey: 'p-acme',
      });
      const projects = (await client.listProjects()) as unknown as Array<{
        projectKey: string;
        assignedAgentIds: string[];
      }>;
      expect(projects.find((p) => p.projectKey === 'p-acme')?.assignedAgentIds).toContain('a1');
    } finally {
      await svc.close();
    }
  });

  it('全链路 R1：域继承授权——他域私有项目 fail-loud（不冒用他域 claim），本域项目落本域', async () => {
    const svc = await startKnowledgeService({
      dbPath: ':memory:',
      port: 0,
      tokens: [{ token: 't1', tenantId: 'platform', gatewayId: 'gw1' }],
      autoRegisterPrincipals: true,
    });
    const client = new KnowledgeClient({
      baseUrl: `http://127.0.0.1:${svc.port}`,
      token: 't1',
      timeoutMs: 5000,
    });
    try {
      const { gateway } = makeGateway({ 'a1': 'acme' }, client);
      await client.createProject({ projectKey: 'p-acme', visibility: 'private' }, 'acme');
      await client.createProject({ projectKey: 'p-def', visibility: 'private' }); // DEFAULT 域

      const writer = { tenantId: 'acme', isPlatformAdmin: false };
      const input = (key: string) =>
        ({
          kind: 'file',
          location: `/tmp/${key}.md`,
          scopeRef: { level: 'project', key },
        }) as never;

      // 他域私有项目：按写者身份解析为不可见 → fail-loud，源绝不落进他域项目
      await expect(gateway.createKnowledgeSource(input('p-def'), writer)).rejects.toThrow(
        /knowledge_project_not_found/,
      );

      // 本域项目：成功且落写者域（acme 身份可见、DEFAULT 身份不可见）
      const created = (await gateway.createKnowledgeSource(
        input('p-acme'),
        writer,
      )) as unknown as { id: string };
      expect(created.id).toBeTruthy();
      const seenFromAcme = (await client.listSources({
        projectKey: 'p-acme',
        tenantId: 'acme',
      })) as unknown as Array<{ id: string }>;
      expect(seenFromAcme.map((s) => s.id)).toContain(created.id);
      const seenFromDefault = (await client.listSources({
        projectKey: 'p-acme',
        tenantId: 'default',
      })) as unknown as unknown[];
      expect(seenFromDefault).toHaveLength(0);
    } finally {
      await svc.close();
    }
  });
});
