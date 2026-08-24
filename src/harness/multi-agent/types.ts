/**
 * Multi-Agent 系统类型定义
 *
 * Harness 层的多 Agent 编排类型。
 */

import type { Agent } from '../../core/loop/agent.js';
import type { ReliabilityHarness } from '../reliability/run-agent.js';
import type { AgentInfo, AgentRelation } from '../../core/interfaces/agent-registry.js';
import type { SessionAwareRunner } from '../runner.js';

// ── Swarm 拓扑 ──

/** Swarm 拓扑类型 */
export type SwarmTopology =
  | 'hierarchical'  // 层级式：coordinator 分配任务给 workers
  | 'peer-to-peer'  // 对等式：Agent 之间直接通信
  | 'pipeline'      // 流水线式：Agent 按顺序处理
  | 'broadcast';    // 广播式：一个 Agent 对多个 Agent

/** Swarm 配置 */
export interface SwarmConfig {
  /** Swarm 名称 */
  name: string;
  /** 拓扑类型 */
  topology: SwarmTopology;
  /** 协调者 Agent ID（hierarchical 模式必需） */
  coordinatorId?: string;
  /** 最大并发 Agent 数 */
  maxConcurrency?: number;
  /** 任务超时（毫秒） */
  taskTimeoutMs?: number;
}

/** Swarm 中的 Agent 节点 */
export interface SwarmAgent {
  /** Agent 注册信息 */
  info: AgentInfo;
  /** Agent 实例 */
  agent: Agent;
  /** 可靠性 Harness */
  harness: ReliabilityHarness;
  /** Session 运行器（可选） */
  runner?: SessionAwareRunner;
}

/** Swarm 任务 */
export interface SwarmTask {
  /** 任务 ID */
  id: string;
  /** 任务描述 */
  description: string;
  /** 任务输入 */
  input: string;
  /** 分配给的 Agent ID */
  assignedTo?: string;
  /** 任务状态 */
  status: 'pending' | 'assigned' | 'running' | 'completed' | 'failed';
  /** 任务结果 */
  result?: string;
  /** 错误信息 */
  error?: string;
  /** 创建时间 */
  createdAt: number;
  /** 完成时间 */
  completedAt?: number;
}

/** Swarm 事件 */
export const SwarmEvents = {
  AGENT_ADDED: 'swarm.agent.added',
  AGENT_REMOVED: 'swarm.agent.removed',
  TASK_CREATED: 'swarm.task.created',
  TASK_ASSIGNED: 'swarm.task.assigned',
  TASK_COMPLETED: 'swarm.task.completed',
  TASK_FAILED: 'swarm.task.failed',
  TOPOLOGY_CHANGED: 'swarm.topology.changed',
} as const;
