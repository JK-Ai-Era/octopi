/**
 * DefaultAgentRegistry — Agent 注册与发现的默认实现
 *
 * @layer harness/collaboration/delegation
 * 实现本域 `registry-types.ts` 的 `AgentRegistry`（`arch/delegation.md` §12.1 重写）。
 *
 * 设计原则（沿用旧实现并修正）：
 * - 不依赖外部存储（v1 内存；跨进程 Registry 归 L3/L4）
 * - 事件驱动：所有变更经 EventBus 通知
 * - 同步操作，适合单进程场景
 * - **委派策略一等**：`query` 支持 `callableOnly` / `callableBy`（§9.2）
 *
 * 与旧 `multi-agent/registry.ts` 的差异：
 * - 新增 `AgentInfo.delegation` 策略字段
 * - `query` 增 `callableOnly` / `callableBy` 过滤
 * - 契约与实现同域（旧版分居两文件）
 */

import type { EventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type {
  AgentInfo,
  AgentQuery,
  AgentRegistry,
  AgentRelation,
  AgentRelationType,
} from './registry-types.js';
import { AgentRegistryEvents, effectiveDelegationPolicy } from './registry-types.js';

/**
 * DefaultAgentRegistry
 *
 * 基于内存的 Agent 注册表实现。
 */
export class DefaultAgentRegistry implements AgentRegistry {
  private readonly agents = new Map<string, AgentInfo>();
  private relations: AgentRelation[] = [];

  /**
   * @param events - 可选 EventBus；提供时发射 `registry.*` 事件
   */
  constructor(private readonly events?: EventBus) {}

  // ── 注册 / 注销 ──

  /**
   * 注册 Agent
   *
   * @param info - Agent 信息（不含时间戳，服务端补）
   */
  register(info: Omit<AgentInfo, 'registeredAt' | 'lastActiveAt'>): void {
    const timestamp = Date.now();
    const record: AgentInfo = {
      ...info,
      traits: [...info.traits],
      // 归一化为生效策略（缺省默认具备委派能力，arch/delegation.md §9.2）；
      // 此后所有消费方读到的都是完整策略，无需各自兜底。
      delegation: effectiveDelegationPolicy(info.delegation),
      registeredAt: timestamp,
      lastActiveAt: timestamp,
    };
    this.agents.set(record.id, record);
    this.emit(AgentRegistryEvents.AGENT_REGISTERED, {
      agentId: record.id,
      name: record.name,
      traits: record.traits,
    });
  }

  /**
   * 注销 Agent（同时清理其关系）
   *
   * @param agentId - Agent ID
   * @returns 是否成功注销
   */
  unregister(agentId: string): boolean {
    const existed = this.agents.delete(agentId);
    if (existed) {
      this.relations = this.relations.filter((r) => r.from !== agentId && r.to !== agentId);
      this.emit(AgentRegistryEvents.AGENT_UNREGISTERED, { agentId });
    }
    return existed;
  }

  // ── 查询 ──

  /**
   * 获取 Agent 信息
   *
   * @param agentId - Agent ID
   * @returns Agent 信息；不存在返回 undefined
   */
  get(agentId: string): AgentInfo | undefined {
    return this.agents.get(agentId);
  }

  /**
   * 查询 Agent
   *
   * @param query - 查询条件（traits 为 **任一**命中）
   * @returns 匹配的 Agent 列表
   */
  query(query: AgentQuery): AgentInfo[] {
    let results = Array.from(this.agents.values());

    if (query.traits && query.traits.length > 0) {
      results = results.filter((agent) =>
        query.traits!.some((t) => agent.traits.includes(t)),
      );
    }

    if (query.status) {
      results = results.filter((agent) => agent.status === query.status);
    }

    if (query.metadata) {
      results = results.filter((agent) => {
        if (!agent.metadata) return false;
        return Object.entries(query.metadata!).every(
          ([key, value]) => agent.metadata![key] === value,
        );
      });
    }

    if (query.callableOnly) {
      results = results.filter((agent) => effectiveDelegationPolicy(agent.delegation).callable);
    }

    if (query.callableBy !== undefined) {
      results = results.filter((agent) => this.isCallableBy(agent, query.callableBy!));
    }

    return results;
  }

  /**
   * 列出所有已注册 Agent
   *
   * @returns Agent 列表
   */
  list(): AgentInfo[] {
    return Array.from(this.agents.values());
  }

  /**
   * 查找具有特定特质的 Agent
   *
   * @param trait - 特质标签
   * @returns 具备该特质的 Agent 列表
   */
  findByTrait(trait: string): AgentInfo[] {
    return Array.from(this.agents.values()).filter((agent) => agent.traits.includes(trait));
  }

  // ── 状态管理 ──

  /**
   * 更新 Agent 状态
   *
   * @param agentId - Agent ID
   * @param status - 新状态
   */
  updateStatus(agentId: string, status: AgentInfo['status']): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const oldStatus = agent.status;
    agent.status = status;
    agent.lastActiveAt = Date.now();

    if (oldStatus !== status) {
      this.emit(AgentRegistryEvents.AGENT_STATUS_CHANGED, {
        agentId,
        oldStatus,
        newStatus: status,
      });
    }
  }

  /**
   * 更新 Agent 活跃时间
   *
   * @param agentId - Agent ID
   */
  touch(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.lastActiveAt = Date.now();
    }
  }

  // ── 关系管理 ──

  /**
   * 添加 Agent 间关系（同 from/to/type 去重）
   *
   * @param relation - 关系描述
   */
  addRelation(relation: AgentRelation): void {
    const exists = this.relations.some(
      (r) => r.from === relation.from && r.to === relation.to && r.type === relation.type,
    );
    if (exists) return;

    this.relations.push(relation);
    this.emit(AgentRegistryEvents.RELATION_ADDED, {
      from: relation.from,
      to: relation.to,
      type: relation.type,
    });
  }

  /**
   * 移除 Agent 间关系
   *
   * @param from - 来源 Agent ID
   * @param to - 目标 Agent ID
   * @param type - 关系类型（不传则移除两者的全部关系）
   */
  removeRelation(from: string, to: string, type?: AgentRelationType): void {
    const before = this.relations.length;
    this.relations = this.relations.filter((r) => {
      if (r.from !== from || r.to !== to) return true;
      if (type && r.type !== type) return true;
      return false;
    });

    if (this.relations.length < before) {
      this.emit(AgentRegistryEvents.RELATION_REMOVED, { from, to, type });
    }
  }

  /**
   * 获取 Agent 的所有关系
   *
   * @param agentId - Agent ID
   * @returns 关系列表（含 from 与 to 两侧）
   */
  getRelations(agentId: string): AgentRelation[] {
    return this.relations.filter((r) => r.from === agentId || r.to === agentId);
  }

  // ── 内部 ──

  /** callableBy 白名单校验（缺省 = 任意） */
  private isCallableBy(agent: AgentInfo, callerAgentId: string): boolean {
    const allowed = agent.delegation?.callableBy;
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(callerAgentId);
  }

  private emit(type: string, data?: Record<string, unknown>): void {
    if (!this.events) return;
    this.events.emit({ type, timestamp: Date.now(), data });
  }
}
