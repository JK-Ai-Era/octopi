/**
 * AgentRegistry — Agent 注册与发现契约（L2 委派契约层）
 *
 * @layer harness/collaboration/delegation
 * 设计权威：`arch/delegation.md` §12.1。
 *
 * **迁移说明**：本契约原居 `collaboration/multi-agent/agent-registry-types.ts`，
 * 随旧 multi-agent 实现（`swarm.ts` / `process.ts`）一并重构。契约**保留**并扩展：
 * `arch/agent-runtime.md` 多 Agent 模型规划的 v2 `CapabilityRouter` 对接
 * `AgentRegistry.findByTrait`，删掉会堵死 Runtime 的路由扩展。
 *
 * 设计原则（沿用原契约）：
 * - 契约与实现分离：本文件只有类型与常量，不含实现
 * - 跨域只 import 本文件 types，不 import 实现
 * - 支持按能力（capability）发现 Agent
 * - 支持 Agent 上下线通知
 * - 支持 Agent 拓扑描述
 *
 * 新增（`arch/delegation.md` §9.2）：
 * - `AgentInfo.delegation` — 委派策略（可否被委派、递归深度、权利天花板、预算）
 */

import type { SessionRights } from '../../governance/session-acl/types.js';
import type { DelegationBudget } from './types.js';

// ── 委派策略（§9.2） ──

/**
 * Agent 的委派策略。
 *
 * 静态可审计：工具面/权限面由 AgentConfig 固定，父 agent 不得现场改写（§9.3 不做 ad-hoc）。
 *
 * **缺省语义**：未声明 `delegation` 的 agent 等价于 `DEFAULT_DELEGATION_POLICY`
 * ——**缺省默认具备委派能力**（可被委派、可发委派、限一层）。
 * 要关闭必须显式写 `callable: false` / `canDelegate: false`。
 * 一律经 `effectiveDelegationPolicy()` 取生效值，不要直接读字段。
 */
export interface AgentDelegationPolicy {
  /** 能否被委派（默认 **true**；显式 false = 只能被用户直接对话） */
  callable: boolean;
  /** 允许哪些 agentId 调我（缺省 = 任意） */
  callableBy?: string[];
  /** 我能不能再委派（默认 **true**） */
  canDelegate: boolean;
  /** 递归上限（缺省 = **1**，即子不能再派；§10.4 成本/爆炸半径兜底） */
  maxDepth?: number;
  /** 被委派时的权利天花板（D3：只能收紧不能放宽） */
  rightsCeiling?: SessionRights;
  /** 委派预算上限（请求预算与此取交集） */
  budget?: DelegationBudget;
}

// ── Agent 描述 ──

/** Agent 注册信息 */
export interface AgentInfo {
  /** Agent 唯一 ID */
  id: string;
  /** Agent 名称（人类可读） */
  name: string;
  /** Agent 描述 */
  description?: string;
  /** Agent 特质标签（供按特质发现；`AgentConfig.traits` 落点）；无权限语义 */
  traits: string[];
  /** 委派策略（§9.2）；整段可省略 = 用 DEFAULT_DELEGATION_POLICY（委派默认开启）*/
  delegation?: AgentDelegationPolicy;
  /** Agent 元数据（必须可序列化） */
  metadata?: Record<string, unknown>;
  /** 注册时间 */
  registeredAt: number;
  /** 最后活跃时间 */
  lastActiveAt: number;
  /** Agent 状态 */
  status: 'active' | 'idle' | 'busy' | 'offline';
}

/** Agent 查询条件 */
export interface AgentQuery {
  /** 按特质过滤 */
  traits?: string[];
  /** 按状态过滤 */
  status?: AgentInfo['status'];
  /** 按元数据过滤 */
  metadata?: Record<string, unknown>;
  /** 仅返回可被委派的 Agent（delegation.callable === true） */
  callableOnly?: boolean;
  /** 按可被指定 caller 委派过滤（校验 delegation.callableBy） */
  callableBy?: string;
}

// ── 拓扑 ──

/** Agent 间关系类型 */
export type AgentRelationType =
  | 'peer'        // 对等关系
  | 'superior'    // 上下级（上级）
  | 'subordinate' // 上下级（下级）
  | 'pipeline'    // 流水线（上游）
  | 'depends';    // 依赖关系

/** Agent 间关系 */
export interface AgentRelation {
  /** 关系来源 Agent */
  from: string;
  /** 关系目标 Agent */
  to: string;
  /** 关系类型 */
  type: AgentRelationType;
  /** 关系元数据 */
  metadata?: Record<string, unknown>;
}

// ── 事件 ──

export const AgentRegistryEvents = {
  /** Agent 注册 */
  AGENT_REGISTERED: 'registry.agent.registered',
  /** Agent 注销 */
  AGENT_UNREGISTERED: 'registry.agent.unregistered',
  /** Agent 状态变更 */
  AGENT_STATUS_CHANGED: 'registry.agent.status_changed',
  /** 关系添加 */
  RELATION_ADDED: 'registry.relation.added',
  /** 关系移除 */
  RELATION_REMOVED: 'registry.relation.removed',
} as const;

// ── 接口定义 ──

/**
 * AgentRegistry 接口
 *
 * Agent 注册与发现的核心契约。
 */
export interface AgentRegistry {
  /**
   * 注册 Agent
   *
   * @param info - Agent 信息
   */
  register(info: Omit<AgentInfo, 'registeredAt' | 'lastActiveAt'>): void;

  /**
   * 注销 Agent
   *
   * @param agentId - Agent ID
   * @returns 是否成功注销
   */
  unregister(agentId: string): boolean;

  /**
   * 获取 Agent 信息
   *
   * @param agentId - Agent ID
   * @returns Agent 信息，不存在返回 undefined
   */
  get(agentId: string): AgentInfo | undefined;

  /**
   * 查询 Agent
   *
   * @param query - 查询条件
   * @returns 匹配的 Agent 列表
   */
  query(query: AgentQuery): AgentInfo[];

  /**
   * 列出所有已注册 Agent
   */
  list(): AgentInfo[];

  /**
   * 更新 Agent 状态
   *
   * @param agentId - Agent ID
   * @param status - 新状态
   */
  updateStatus(agentId: string, status: AgentInfo['status']): void;

  /**
   * 更新 Agent 活跃时间
   *
   * @param agentId - Agent ID
   */
  touch(agentId: string): void;

  /**
   * 添加 Agent 间关系
   *
   * @param relation - 关系描述
   */
  addRelation(relation: AgentRelation): void;

  /**
   * 移除 Agent 间关系
   *
   * @param from - 来源 Agent ID
   * @param to - 目标 Agent ID
   * @param type - 关系类型（不传则移除所有关系）
   */
  removeRelation(from: string, to: string, type?: AgentRelationType): void;

  /**
   * 获取 Agent 的所有关系
   *
   * @param agentId - Agent ID
   * @returns 关系列表
   */
  getRelations(agentId: string): AgentRelation[];

  /**
   * 查找具有特定特质的 Agent
   *
   * @param trait - 特质标签
   * @returns 具备该特质的 Agent 列表
   */
  findByTrait(trait: string): AgentInfo[];
}

/**
 * 缺省委派策略（`arch/delegation.md` §9.2）。
 *
 * agent **缺省默认具备委派能力**：可被委派、可发委派，但**只准一层**
 * （`maxDepth: 1` = 我能派子，子不能再派）。默认开启委派时，
 * 递归层数是唯一能自动限住 runaway 的旋钮，故这里必须收紧。
 */
export const DEFAULT_DELEGATION_POLICY: AgentDelegationPolicy = {
  callable: true,
  canDelegate: true,
  maxDepth: 1,
};

/**
 * 取 agent 的**生效**委派策略（未声明即用缺省）
 *
 * @param delegation - agent 声明的策略，可缺省
 * @returns 生效策略（永远不是 undefined）
 */
export function effectiveDelegationPolicy(
  delegation: AgentDelegationPolicy | undefined,
): AgentDelegationPolicy {
  if (!delegation) return { ...DEFAULT_DELEGATION_POLICY };
  return {
    ...DEFAULT_DELEGATION_POLICY,
    ...delegation,
    maxDepth: delegation.maxDepth ?? DEFAULT_DELEGATION_POLICY.maxDepth,
  };
}
