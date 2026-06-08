/**
 * AgentSwarm — 多 Agent 编排器
 *
 * Harness 层组件。管理多个 Agent 的协作。
 *
 * 支持的拓扑：
 * - hierarchical: 协调者分配任务给工作者 Agent
 * - peer-to-peer: Agent 之间直接通信
 * - pipeline: Agent 按顺序处理（前一个的输出是后一个的输入）
 * - broadcast: 一个 Agent 的输出广播给所有其他 Agent
 *
 * 设计原则：
 * - 基于 AgentRegistry 发现和管理 Agent
 * - 基于 EventBus 进行事件驱动通信
 * - 每个 Agent 有独立的运行时作用域
 * - 编排是策略，不是机制 — 可替换的编排逻辑
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from '../../core/event-bus.js';
import type { Message } from '../../core/types.js';
import type { AgentEngine, RunConfig } from '../../core/engine.js';
import type { AgentRegistry, AgentInfo } from '../../core/interfaces/agent-registry.js';
import type { SwarmConfig, SwarmAgent, SwarmTask } from './types.js';
import { SwarmEvents } from './types.js';

// ── 编排策略接口 ──

/**
 * 编排策略
 *
 * 决定如何将任务分配给 Agent。
 * 不同的拓扑有不同的策略实现。
 */
export interface OrchestrationStrategy {
  /** 策略名称 */
  readonly name: string;

  /**
   * 选择执行任务的 Agent
   *
   * @param task - 待执行的任务
   * @param agents - 可用的 Agent 列表
   * @param registry - Agent 注册表
   * @returns 选中的 Agent ID，null 表示没有合适的 Agent
   */
  selectAgent(
    task: SwarmTask,
    agents: Map<string, SwarmAgent>,
    registry: AgentRegistry,
  ): string | null;

  /**
   * 处理任务结果
   *
   * @param task - 已完成的任务
   * @param result - 任务结果
   * @param agents - 所有 Agent
   * @returns 后续任务列表（可选）
   */
  onTaskComplete?(
    task: SwarmTask,
    result: string,
    agents: Map<string, SwarmAgent>,
  ): SwarmTask[];
}

// ── 内置策略 ──

/** 轮询策略：依次分配给可用 Agent */
export class RoundRobinStrategy implements OrchestrationStrategy {
  readonly name = 'round-robin';
  private _index = 0;

  selectAgent(_task: SwarmTask, agents: Map<string, SwarmAgent>): string | null {
    const agentIds = Array.from(agents.keys()).filter(id => {
      const agent = agents.get(id);
      return agent?.info.status === 'active' || agent?.info.status === 'idle';
    });

    if (agentIds.length === 0) return null;

    const selected = agentIds[this._index % agentIds.length];
    this._index++;
    return selected;
  }
}

/** 能力匹配策略：根据任务描述匹配 Agent 能力 */
export class CapabilityStrategy implements OrchestrationStrategy {
  readonly name = 'capability-match';

  selectAgent(task: SwarmTask, agents: Map<string, SwarmAgent>, registry: AgentRegistry): string | null {
    // 从任务描述中提取关键词作为能力需求
    const keywords = task.description.toLowerCase().split(/\s+/);

    let bestAgent: string | null = null;
    let bestScore = 0;

    for (const [id, agent] of agents) {
      if (agent.info.status !== 'active' && agent.info.status !== 'idle') continue;

      // 计算能力匹配分数
      const score = agent.info.capabilities.reduce((acc, cap) => {
        const capLower = cap.toLowerCase();
        return acc + keywords.filter(kw => capLower.includes(kw) || kw.includes(capLower)).length;
      }, 0);

      if (score > bestScore) {
        bestScore = score;
        bestAgent = id;
      }
    }

    // 没有匹配时回退到轮询
    if (bestAgent === null) {
      const activeAgents = Array.from(agents.entries()).filter(
        ([, a]) => a.info.status === 'active' || a.info.status === 'idle',
      );
      if (activeAgents.length > 0) {
        bestAgent = activeAgents[0][0];
      }
    }

    return bestAgent;
  }
}

/** 流水线策略：按注册顺序依次传递 */
export class PipelineStrategy implements OrchestrationStrategy {
  readonly name = 'pipeline';
  private _agentOrder: string[] = [];

  constructor(agentOrder?: string[]) {
    this._agentOrder = agentOrder ?? [];
  }

  setOrder(agentIds: string[]): void {
    this._agentOrder = [...agentIds];
  }

  selectAgent(task: SwarmTask, agents: Map<string, SwarmAgent>): string | null {
    // 如果任务还没有分配过，分配给第一个 Agent
    if (!task.assignedTo) {
      return this._agentOrder[0] ?? null;
    }

    // 否则分配给下一个
    const currentIndex = this._agentOrder.indexOf(task.assignedTo);
    if (currentIndex < 0 || currentIndex >= this._agentOrder.length - 1) return null;

    return this._agentOrder[currentIndex + 1];
  }

  onTaskComplete(task: SwarmTask, result: string, agents: Map<string, SwarmAgent>): SwarmTask[] {
    // 检查是否还有下一个 Agent
    const currentIndex = this._agentOrder.indexOf(task.assignedTo!);
    if (currentIndex < 0 || currentIndex >= this._agentOrder.length - 1) return [];

    // 创建传递给下一个 Agent 的任务
    return [{
      id: `task-${randomUUID().slice(0, 8)}`,
      description: task.description,
      input: result,
      assignedTo: this._agentOrder[currentIndex + 1],
      status: 'pending',
      createdAt: Date.now(),
    }];
  }
}

// ── AgentSwarm ──

/**
 * AgentSwarm — 多 Agent 编排器
 *
 * 管理多个 Agent 的生命周期和任务分配。
 */
export class AgentSwarm {
  readonly id: string;
  readonly name: string;
  readonly topology: SwarmConfig['topology'];

  private _agents = new Map<string, SwarmAgent>();
  private _tasks = new Map<string, SwarmTask>();
  private _strategy: OrchestrationStrategy;
  private _registry: AgentRegistry;
  private _events: EventBus;
  private _maxConcurrency: number;
  private _taskTimeoutMs: number;
  private _running = false;

  constructor(
    config: SwarmConfig,
    registry: AgentRegistry,
    events: EventBus,
    strategy?: OrchestrationStrategy,
  ) {
    this.id = `swarm-${randomUUID().slice(0, 8)}`;
    this.name = config.name;
    this.topology = config.topology;
    this._registry = registry;
    this._events = events;
    this._maxConcurrency = config.maxConcurrency ?? 5;
    this._taskTimeoutMs = config.taskTimeoutMs ?? 60_000;
    this._strategy = strategy ?? this._createDefaultStrategy(config);
  }

  // ── Agent 管理 ──

  /**
   * 添加 Agent 到 Swarm
   */
  addAgent(agent: SwarmAgent): void {
    this._agents.set(agent.info.id, agent);
    this._registry.register(agent.info);
    this._emit(SwarmEvents.AGENT_ADDED, {
      agentId: agent.info.id,
      name: agent.info.name,
      capabilities: agent.info.capabilities,
    });
  }

  /**
   * 从 Swarm 移除 Agent
   */
  removeAgent(agentId: string): void {
    this._agents.delete(agentId);
    this._registry.unregister(agentId);
    this._emit(SwarmEvents.AGENT_REMOVED, { agentId });
  }

  /**
   * 获取 Agent
   */
  getAgent(agentId: string): SwarmAgent | undefined {
    return this._agents.get(agentId);
  }

  /**
   * 列出所有 Agent
   */
  listAgents(): SwarmAgent[] {
    return Array.from(this._agents.values());
  }

  // ── 任务管理 ──

  /**
   * 提交任务
   */
  submitTask(description: string, input: string): SwarmTask {
    const task: SwarmTask = {
      id: `task-${randomUUID().slice(0, 8)}`,
      description,
      input,
      status: 'pending',
      createdAt: Date.now(),
    };

    this._tasks.set(task.id, task);
    this._emit(SwarmEvents.TASK_CREATED, { taskId: task.id, description });

    return task;
  }

  /**
   * 执行任务
   *
   * 根据编排策略选择 Agent 并执行任务。
   */
  async executeTask(task: SwarmTask): Promise<SwarmTask> {
    // 选择 Agent
    const agentId = this._strategy.selectAgent(task, this._agents, this._registry);
    if (!agentId) {
      task.status = 'failed';
      task.error = 'No suitable agent found';
      task.completedAt = Date.now();
      this._emit(SwarmEvents.TASK_FAILED, { taskId: task.id, error: task.error });
      return task;
    }

    const agent = this._agents.get(agentId);
    if (!agent) {
      task.status = 'failed';
      task.error = `Agent ${agentId} not found in swarm`;
      task.completedAt = Date.now();
      return task;
    }

    // 分配任务
    task.assignedTo = agentId;
    task.status = 'assigned';
    this._emit(SwarmEvents.TASK_ASSIGNED, { taskId: task.id, agentId });

    // 更新 Agent 状态
    this._registry.updateStatus(agentId, 'busy');

    try {
      // 执行任务
      task.status = 'running';

      const messages: Message[] = [{
        role: 'user',
        content: task.input,
        timestamp: Date.now(),
      }];

      const runConfig: RunConfig = {
        systemPrompt: `You are agent "${agent.info.name}" in a multi-agent swarm. Your capabilities: ${agent.info.capabilities.join(', ')}. Execute the following task:\n\n${task.description}`,
        agentId: agent.info.id,
      };

      let result = '';
      for await (const event of agent.engine.run(messages, runConfig)) {
        if (event.type === 'turn.end' && event.data?.content) {
          result = event.data.content as string;
        }
      }

      task.result = result;
      task.status = 'completed';
      task.completedAt = Date.now();

      this._emit(SwarmEvents.TASK_COMPLETED, { taskId: task.id, agentId, result });

      // 处理后续任务（如流水线）
      if (this._strategy.onTaskComplete) {
        const followUpTasks = this._strategy.onTaskComplete(task, result, this._agents);
        for (const followUp of followUpTasks) {
          this._tasks.set(followUp.id, followUp);
          // 递归执行后续任务
          await this.executeTask(followUp);
        }
      }

      // 恢复 Agent 状态
      this._registry.updateStatus(agentId, 'idle');

      return task;
    } catch (err) {
      task.status = 'failed';
      task.error = err instanceof Error ? err.message : String(err);
      task.completedAt = Date.now();

      this._emit(SwarmEvents.TASK_FAILED, { taskId: task.id, agentId, error: task.error });
      this._registry.updateStatus(agentId, 'idle');

      return task;
    }
  }

  /**
   * 广播任务给所有 Agent
   */
  async broadcastTask(description: string, input: string): Promise<SwarmTask[]> {
    const tasks: SwarmTask[] = [];

    for (const [agentId, agent] of this._agents) {
      if (agent.info.status !== 'active' && agent.info.status !== 'idle') continue;

      const task = this.submitTask(description, input);
      task.assignedTo = agentId;
      tasks.push(task);
    }

    // 并发执行所有任务
    const results = await Promise.all(
      tasks.map(task => this.executeTask(task)),
    );

    return results;
  }

  /**
   * 获取任务
   */
  getTask(taskId: string): SwarmTask | undefined {
    return this._tasks.get(taskId);
  }

  /**
   * 列出所有任务
   */
  listTasks(): SwarmTask[] {
    return Array.from(this._tasks.values());
  }

  // ── 策略管理 ──

  /**
   * 设置编排策略
   */
  setStrategy(strategy: OrchestrationStrategy): void {
    this._strategy = strategy;
  }

  /**
   * 获取当前策略
   */
  getStrategy(): OrchestrationStrategy {
    return this._strategy;
  }

  // ── 内部方法 ──

  private _createDefaultStrategy(config: SwarmConfig): OrchestrationStrategy {
    switch (config.topology) {
      case 'hierarchical':
        return new CapabilityStrategy();
      case 'pipeline':
        return new PipelineStrategy();
      case 'broadcast':
        return new RoundRobinStrategy();
      case 'peer-to-peer':
        return new CapabilityStrategy();
      default:
        return new RoundRobinStrategy();
    }
  }

  private _emit(type: string, data?: Record<string, unknown>): void {
    this._events.emit({
      type,
      timestamp: Date.now(),
      data,
    });
  }
}
