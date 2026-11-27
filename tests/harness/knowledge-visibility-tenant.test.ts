/**
 * 管理面 visibility 写路径的租户断言（arch/multi-tenancy.md §6，T3c）。
 *
 * 回归锁（F1）：曾有写路径不带租户断言 → 写域降级 DEFAULT，
 * 「挂载成功但 agent 的 run 永远看不见」的假成功；§6「挂载不出租户」也验不出越域。
 * 断言头（x-octopi-tenant）生效后：
 * - 越域挂载由既有 projectGate* 写侧防绕过闸 fail-loud（单源判定，测试只锁行为）
 * - 同租户挂载落断言域（按域撤销才清得掉 = 行确实落在该域）
 * - platform 公共项目 = 跨租户共享唯一合法形态
 */
import { describe, expect, it } from 'vitest';
import { startKnowledgeService } from '@octopi-agent/engine/harness/knowledge/serve.js';
import { KnowledgeClient } from '@octopi-agent/engine/harness/knowledge/client.js';

interface ProjectRow {
  tenantId: string;
  projectKey: string;
  assignedAgentIds: string[];
}

describe('visibility 租户断言（§6：挂载不出租户）', () => {
  it('越域挂载 fail-loud；同租户挂载落断言域；platform 公共可跨租户', async () => {
    const svc = await startKnowledgeService({
      dbPath: ':memory:',
      port: 0,
      // 模拟 gateway broker：platform 域 token，写域靠 x-octopi-tenant 断言上行
      tokens: [{ token: 't1', tenantId: 'platform', gatewayId: 'gw1' }],
      autoRegisterPrincipals: true,
      allowPublic: true,
    });
    const client = new KnowledgeClient({
      baseUrl: `http://127.0.0.1:${svc.port}`,
      token: 't1',
      timeoutMs: 5000,
    });
    try {
      // 项目按域登记：p-def 落 default 域（无断言），p-acme 落 acme 域，p-pub 落 platform 公共面
      await client.createProject({ projectKey: 'p-def', visibility: 'private' });
      await client.createProject({ projectKey: 'p-acme', visibility: 'private' }, 'acme');
      await client.createProject({ projectKey: 'p-pub', visibility: 'public' }, 'platform');

      // §6：default 私有项目挂给 acme 归属 agent → fail-loud
      // （若断言头未生效，写身份会降级 DEFAULT 而假成功——此断言同时锁 client 透传）
      await expect(
        client.visibility('agent-x', 'assignProject', { projectKey: 'p-def' }, { tenantId: 'acme' }),
      ).rejects.toThrow(/not visible to writer/);

      // 同租户挂载成功，且行落断言域（acme）：default 域撤销清不掉，acme 域撤销才清
      await client.visibility(
        'agent-x',
        'assignProject',
        { projectKey: 'p-acme' },
        { tenantId: 'acme' },
      );
      let projects = (await client.listProjects()) as unknown as ProjectRow[];
      expect(projects.find((p) => p.projectKey === 'p-acme')?.assignedAgentIds).toContain('agent-x');

      await client.visibility('agent-x', 'unassignProject', { projectKey: 'p-acme' });
      projects = (await client.listProjects()) as unknown as ProjectRow[];
      expect(projects.find((p) => p.projectKey === 'p-acme')?.assignedAgentIds).toContain(
        'agent-x',
      );

      await client.visibility(
        'agent-x',
        'unassignProject',
        { projectKey: 'p-acme' },
        { tenantId: 'acme' },
      );
      projects = (await client.listProjects()) as unknown as ProjectRow[];
      expect(
        projects.find((p) => p.projectKey === 'p-acme')?.assignedAgentIds ?? [],
      ).not.toContain('agent-x');

      // platform 公共项目 = 跨租户共享唯一合法形态（§6）
      await client.visibility(
        'agent-x',
        'assignProject',
        { projectKey: 'p-pub' },
        { tenantId: 'acme' },
      );
      projects = (await client.listProjects()) as unknown as ProjectRow[];
      expect(projects.find((p) => p.projectKey === 'p-pub')?.assignedAgentIds).toContain('agent-x');

      // 失败的越域挂载不得留下任何行
      projects = (await client.listProjects()) as unknown as ProjectRow[];
      expect(projects.find((p) => p.projectKey === 'p-def')?.assignedAgentIds ?? []).toHaveLength(
        0,
      );
    } finally {
      await svc.close();
    }
  });
});
