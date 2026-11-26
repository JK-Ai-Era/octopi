/**
 * WS 租户身份钩子（arch/multi-tenancy.md §9.1-3，T4b）。
 *
 * HttpChannelAdapter 的 resolveWsIdentity / canSubscribe / isHostEffectTarget
 * 实现单源：daemon 接线与测试都用本工厂——接线逻辑不复制（T4b 评审教训：
 * 测试自造 canSubscribe 曾掩盖 daemon 真实接线的断裂）。
 */
import type { WsTenantIdentity } from '@octopi-agent/gateway/protocols/http.js';
import type { AgentId } from '@octopi-agent/engine/harness/governance/registry/types.js';
import { DEFAULT_TENANT_ID } from '@octopi-agent/core/types.js';

/** 钩子依赖：gateway 的 registry 与会话读口（只读） */
export interface WsIdentityHookDeps {
  resolveToken: (token: string) => { tenantId: string; isPlatformAdmin: boolean } | null;
  getSessionTenant: (sessionId: string) => Promise<string | undefined>;
  getAgentTenant: (agentId: string) => string | undefined;
  /** agent 的生效 effectPolicy.mode（A2 host 认证面闸；gateway.getAgentEffectiveMode） */
  getAgentEffectiveMode: (agentId: string) => string;
  /** 会话归属 agent 的生效模式（gateway.getAgentEffectiveModeBySession） */
  getSessionEffectiveMode: (sessionId: string) => Promise<string | undefined>;
}

/**
 * 构造 WS 身份解析 + 订阅授权 + host 目标判定钩子。
 *
 * @param deps - registry/token 与会话/agent 归属读口
 * @returns HttpChannelAdapter 的 resolveWsIdentity / canSubscribe / isHostEffectTarget 实现
 */
export function createWsIdentityHooks(deps: WsIdentityHookDeps): {
  resolveWsIdentity: (registryToken: string) => WsTenantIdentity | null;
  canSubscribe: (target: { sessionId?: string; agentId?: string }, identity: WsTenantIdentity) => Promise<boolean>;
  isHostEffectTarget: (target: { sessionId?: string; agentId?: string }) => Promise<boolean>;
} {
  return {
    resolveWsIdentity: (registryToken) => {
      const user = deps.resolveToken(registryToken);
      return user ? { tenantId: user.tenantId, isPlatformAdmin: user.isPlatformAdmin } : null;
    },
    canSubscribe: async (target, identity) => {
      if (identity.isPlatformAdmin) return true;
      if (target.sessionId) {
        const tenant = await deps.getSessionTenant(target.sessionId);
        return tenant !== undefined && (tenant ?? DEFAULT_TENANT_ID) === identity.tenantId;
      }
      if (target.agentId) {
        // registry agent = 租户资产；config agent = DEFAULT 域资产——均须与身份同域
        return (deps.getAgentTenant(target.agentId) ?? DEFAULT_TENANT_ID) === identity.tenantId;
      }
      return false;
    },
    // A2 host 认证面（2026-11-27 拍板）：host 生效模式 agent 的一切外部操作
    // （含发消息）都要认证。任一维（显式 agentId 或会话归属）解析为 host 即算
    // host 目标——两个都给时从严（防改绑绕过）。
    isHostEffectTarget: async (target) => {
      if (target.agentId && deps.getAgentEffectiveMode(target.agentId) === 'host') return true;
      if (target.sessionId) {
        const mode = await deps.getSessionEffectiveMode(target.sessionId);
        return mode === 'host';
      }
      return false;
    },
  };
}

/** registry AgentRecord 归属读口的便捷装配（gateway.getRegistry()） */
export function agentTenantReader(
  getRegistry: () => { getAgent(agentId: AgentId): { tenantId?: string } | null } | undefined,
): (agentId: string) => string | undefined {
  return (agentId) => getRegistry()?.getAgent(agentId as AgentId)?.tenantId;
}
