/**
 * registry-bridge — registry 托管 agent → 可跑 AgentDefinition + 家当物化
 * （arch/multi-tenancy.md §2 不变量 2/3、§4 隔离矩阵）。
 *
 * registry 是定义权威；机器文件是物化态（可重建）：
 * - home = `agents/<agentId>/`（skillDirectory 缺省 `home/skills`）
 * - workspace = `workspace/<tenantId>/<agentId>/`（路径前缀隔离）
 *
 * definition JSON 是**白名单**（租户可写的只有 agent 描述面）：
 * 治理面（effectPolicy/maxSessionRights/delegation/channelBindings/knowledge…）、
 * 身份（id/tenantId）与机器坐标（home/workspace/skillDirectory）一律宿主派生——
 * 黑名单挡不住 `mode:'host'` 这类自提权（评审 MAJ-5）。未知键 fail-loud。
 *
 * env 引用（`${...}`）在 definition 中一律拒绝（评审 MAJ-6）：租户输入不进
 * `${ENV}` 展开管线，宿主 env（含 provider key）对租户字符串不可见。
 * effectPolicy 恒派生 `{ mode: 'workspace' }`（secure-by-default；不继承平台 host）。
 *
 * @module
 */

import type { AgentRecord } from '@octopi-agent/engine/harness/governance/registry/types.js';
import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';
import { agentHomeDir, agentWorkspaceDir } from '@octopi-agent/engine/paths.js';
import { normalizeConfigRaw, resolveAgentDefinition } from './config.js';
import { ensureAgentDirs, getOctopiHome } from './init.js';

/** definition JSON 允许的键（白名单；扩展须按期评审后加，勿改回黑名单） */
const ALLOWED_DEFINITION_KEYS = new Set(['name', 'description', 'model', 'persona', 'tools', 'skills', 'contextEngine']);

export interface RegistryAgentBridgeOptions {
  /** 当前平台 raw 配置（provider / 模型档解析上下文）；每次物化现取（热更可见） */
  getRawConfig: () => Record<string, unknown>;
  /** 家当物化根（OCTOPI_HOME）；缺省 getOctopiHome() */
  homeDir?: string;
}

export interface RegistryAgentBridge {
  /**
   * 校验 definition、产出可跑 AgentDefinition 并物化家当（ensureAgentDirs，幂等）。
   * 先校验后物化——坏 definition 不留孤儿目录（评审 MIN-7）。
   *
   * @param record - registry agent 记录（归属与身份的权威）
   * @returns AgentDefinition（id/tenantId/home/workspace 由记录 + 派生注入）
   * @throws definition 非法 JSON / 含禁用键 / 含 env 引用 / 配置校验失败（fail-loud）
   */
  materialize(record: AgentRecord): Promise<AgentDefinition>;
}

/** 递归收集字符串值（env 引用扫描用） */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

/**
 * 创建 registry agent 桥。
 *
 * @param options - raw 配置取数 + 物化根
 */
export function createRegistryAgentBridge(options: RegistryAgentBridgeOptions): RegistryAgentBridge {
  const homeDir = options.homeDir ?? getOctopiHome();
  return {
    async materialize(record: AgentRecord): Promise<AgentDefinition> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(record.definition);
      } catch {
        throw new Error(`registry_invalid_definition: agent ${record.agentId} definition is not valid JSON`);
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`registry_invalid_definition: agent ${record.agentId} definition must be a JSON object`);
      }
      const entry = parsed as Record<string, unknown>;

      // 白名单（MAJ-5）：治理/身份/机器坐标宿主派生；未知键 fail-loud
      for (const key of Object.keys(entry)) {
        if (!ALLOWED_DEFINITION_KEYS.has(key)) {
          throw new Error(
            `registry_invalid_definition: "${key}" is host-governed and not allowed in agent definition (allowed: ${[...ALLOWED_DEFINITION_KEYS].join(', ')})`,
          );
        }
      }

      // env 引用拒绝（MAJ-6）：租户字符串不进宿主 env 展开管线
      const strings: string[] = [];
      collectStrings(entry, strings);
      if (strings.some((s) => s.includes('${'))) {
        throw new Error(
          'registry_invalid_definition: "${...}" env references are not allowed in agent definition (host env is invisible to tenant input)',
        );
      }

      const effective: Record<string, unknown> = {
        ...entry,
        id: record.agentId,
        home: agentHomeDir(homeDir, record.agentId),
        workspace: agentWorkspaceDir(homeDir, record.tenantId, record.agentId),
        // effectPolicy 宿主派生（MAJ-5）：租户 agent 恒 workspace 姿态，不继承平台 host
        effectPolicy: { mode: 'workspace' },
      };
      const normalized = normalizeConfigRaw({
        ...options.getRawConfig(),
        agents: [effective],
      });
      const ac = normalized.agents.find((a) => a.id === record.agentId);
      if (!ac) {
        throw new Error(`registry_invalid_definition: agent ${record.agentId} failed normalization`);
      }
      const def = resolveAgentDefinition(ac, normalized);

      // 校验通过后才物化家当（MIN-7）
      await ensureAgentDirs(record.agentId, homeDir, record.tenantId);
      return { ...def, tenantId: record.tenantId };
    },
  };
}
