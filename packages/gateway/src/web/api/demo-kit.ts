/**
 * DemoKitService — 演示任务包下发面（批 3-1）。
 *
 * 单源：样例资料与剧本 prompt 住在 engine `config-admin/demo-kit.ts`；此面只做
 * 「demo agent 发现 + prompt 下发」的 HTTP 语义。
 *
 * 发现判据（评审 B1）：definition.name === DEMO_AGENT_NAME——不把 demo 标记塞进
 * definition（registry-bridge 宿主治理白名单只放行 name/description/model/persona/
 * tools/skills/contextEngine）。
 *
 * 租户边界（评审 M1）：携带 X-Registry-Token 时按 token 租户可见范围（listAgents）
 * 发现；无 token 仅 personal 部署放行（单租户无跨租户暴露面）——`listAllAgents` 是
 * 宿主管理面 API，不经 HTTP 请求路径暴露。
 *
 * @module
 */

import { join } from 'node:path';
import { DEMO_AGENT_NAME, DEMO_SCRIPT_PROMPTS } from '@octopi-agent/engine/config-admin/demo-kit.js';

/** 下发载荷 */
export interface DemoKitPayload {
  available: boolean;
  agentId?: string;
  prompt?: string;
}

/** 服务依赖 */
export interface DemoKitServiceDeps {
  /** OCTOPI_HOME（registry.db 所在） */
  octopiHome: string;
  /** 部署模式（①personal 免登录；②③需 token 才可发现 demo agent） */
  deploymentMode?: string;
}

/** 演示任务包服务 */
export class DemoKitService {
  private deps: DemoKitServiceDeps;

  constructor(deps: DemoKitServiceDeps) {
    this.deps = deps;
  }

  /**
   * 读取 demo kit（幂等只读）。
   *
   * @param lang - prompt 语言（缺省 zh）
   * @param registryToken - 请求携带的 X-Registry-Token（可空）
   * @returns 下发载荷；无权发现/不存在时 available=false
   */
  async getKit(lang: 'zh' | 'en' = 'zh', registryToken?: string): Promise<DemoKitPayload> {
    const { RegistryService } = await import('@octopi-agent/engine/harness/governance/registry/service.js');
    const registry = await RegistryService.create({ dbPath: join(this.deps.octopiHome, 'registry.db') });
    try {
      const isDemo = (a: { definition: string; ownerUserId?: unknown }): boolean => {
        try {
          return (JSON.parse(a.definition) as Record<string, unknown>).name === DEMO_AGENT_NAME;
        } catch {
          return false;
        }
      };
      let demo: { agentId: unknown } | undefined;
      if (registryToken) {
        const viewer = await registry.resolveToken(registryToken);
        if (!viewer) return { available: false }; // 过期/无效 token：不暴露
        demo = registry
          .listAgents({ tenantId: viewer.tenantId as never, viewerUserId: viewer.userId as never })
          .find(isDemo);
      } else if (this.deps.deploymentMode === 'personal' || this.deps.deploymentMode === undefined) {
        // personal（或部署模式未定的存量部署）：单租户，无跨租户暴露面
        demo = registry.listAllAgents().find(isDemo);
      } else {
        return { available: false }; // ②③模式无 token 不暴露
      }
      if (!demo) return { available: false };
      return { available: true, agentId: demo.agentId as string, prompt: DEMO_SCRIPT_PROMPTS[lang] };
    } finally {
      registry.close();
    }
  }
}
