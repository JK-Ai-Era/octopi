/**
 * AgentRegistry — Agent 注册与发现接口
 *
 * 职责：让 Agent 之间能互相发现和通信。
 * 实现方：内存注册表、分布式注册表等。
 *
 * 设计原则：
 * - 接口定义在 Core，实现在 Harness
 * - 支持按能力（capability）发现 Agent
 * - 支持 Agent 上下线通知
 * - 支持多 Agent 拓扑描述
 */

// ── Agent 描述 ──

/** Agent 注册信息 */
export interface AgentInfo {
  /** Agent 唯一 ID */
  id: string;
  /** Agent 名称（人类可读） */
  name: string;
  /** Agent 描述 */
  description?: string;
  /** Agent 能力标签（用于发现） */
  capabilities: string[];
  /** Agent 元数据 */
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
  /** 按能力过滤 */
  capabilities?: string[];
  /** 按状态过滤 */
  status?: AgentInfo['status'];
  /** 按元数据过滤 */
  metadata?: Record<string, unknown>;
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
   * 查找具有特定能力的 Agent
   *
   * @param capability - 能力标签
   * @returns 具备该能力的 Agent 列表
   */
  findByCapability(capability: string): AgentInfo[];
}
