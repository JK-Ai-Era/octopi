/**
 * DefaultAgentRegistry — Agent 注册与发现的默认实现
 *
 * Harness 层组件。实现 Core 层的 AgentRegistry 接口。
 * 基于内存存储，支持按能力发现、状态管理、关系管理。
 *
 * 设计原则：
 * - 实现 Core 接口，不依赖外部存储
 * - 事件驱动：所有变更通过 EventBus 通知
 * - 线程安全：操作是同步的，适合单进程场景
 */

import type {
  AgentRegistry,
  AgentInfo,
  AgentQuery,
  AgentRelation,
  AgentRelationType,
} from '../../../core/interfaces/agent-registry.js';
import { AgentRegistryEvents } from '../../../core/interfaces/agent-registry.js';
import type { EventBus } from '../../../core/primitives/event-bus.js';

/**
 * DefaultAgentRegistry
 *
 * 基于内存的 Agent 注册表实现。
 */
export class DefaultAgentRegistry implements AgentRegistry {
  private _agents = new Map<string, AgentInfo>();
  private _relations: AgentRelation[] = [];
  private _events?: EventBus;

  constructor(events?: EventBus) {
    this._events = events;
  }

  // ── 注册 / 注销 ──

  register(info: Omit<AgentInfo, 'registeredAt' | 'lastActiveAt'>): void {
    const now = Date.now();
    const agentInfo: AgentInfo = {
      ...info,
      registeredAt: now,
      lastActiveAt: now,
    };

    this._agents.set(info.id, agentInfo);

    this._emit(AgentRegistryEvents.AGENT_REGISTERED, {
      agentId: info.id,
      name: info.name,
      capabilities: info.capabilities,
    });
  }

  unregister(agentId: string): boolean {
    const existed = this._agents.delete(agentId);
    if (existed) {
      // 清理相关关系
      this._relations = this._relations.filter(
        r => r.from !== agentId && r.to !== agentId,
      );

      this._emit(AgentRegistryEvents.AGENT_UNREGISTERED, { agentId });
    }
    return existed;
  }

  // ── 查询 ──

  get(agentId: string): AgentInfo | undefined {
    return this._agents.get(agentId);
  }

  query(query: AgentQuery): AgentInfo[] {
    let results = Array.from(this._agents.values());

    if (query.capabilities && query.capabilities.length > 0) {
      results = results.filter(agent =>
        query.capabilities!.some(cap => agent.capabilities.includes(cap)),
      );
    }

    if (query.status) {
      results = results.filter(agent => agent.status === query.status);
    }

    if (query.metadata) {
      results = results.filter(agent => {
        if (!agent.metadata) return false;
        return Object.entries(query.metadata!).every(
          ([key, value]) => agent.metadata![key] === value,
        );
      });
    }

    return results;
  }

  list(): AgentInfo[] {
    return Array.from(this._agents.values());
  }

  findByCapability(capability: string): AgentInfo[] {
    return Array.from(this._agents.values()).filter(
      agent => agent.capabilities.includes(capability),
    );
  }

  // ── 状态管理 ──

  updateStatus(agentId: string, status: AgentInfo['status']): void {
    const agent = this._agents.get(agentId);
    if (!agent) return;

    const oldStatus = agent.status;
    agent.status = status;
    agent.lastActiveAt = Date.now();

    if (oldStatus !== status) {
      this._emit(AgentRegistryEvents.AGENT_STATUS_CHANGED, {
        agentId,
        oldStatus,
        newStatus: status,
      });
    }
  }

  touch(agentId: string): void {
    const agent = this._agents.get(agentId);
    if (agent) {
      agent.lastActiveAt = Date.now();
    }
  }

  // ── 关系管理 ──

  addRelation(relation: AgentRelation): void {
    // 去重
    const exists = this._relations.some(
      r => r.from === relation.from && r.to === relation.to && r.type === relation.type,
    );
    if (exists) return;

    this._relations.push(relation);

    this._emit(AgentRegistryEvents.RELATION_ADDED, {
      from: relation.from,
      to: relation.to,
      type: relation.type,
    });
  }

  removeRelation(from: string, to: string, type?: AgentRelationType): void {
    const before = this._relations.length;
    this._relations = this._relations.filter(r => {
      if (r.from !== from || r.to !== to) return true;
      if (type && r.type !== type) return true;
      return false;
    });

    if (this._relations.length < before) {
      this._emit(AgentRegistryEvents.RELATION_REMOVED, { from, to, type });
    }
  }

  getRelations(agentId: string): AgentRelation[] {
    return this._relations.filter(
      r => r.from === agentId || r.to === agentId,
    );
  }

  // ── 内部方法 ──

  private _emit(type: string, data?: Record<string, unknown>): void {
    if (this._events) {
      this._events.emit({
        type,
        timestamp: Date.now(),
        data,
      });
    }
  }
}
