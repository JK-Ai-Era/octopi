/**
 * 编排层 — Agent 循环策略
 *
 * 目前支持：单 Agent 循环（已在 core/agent.ts 实现）
 * 待实现：多 Agent 协作、状态机、任务图
 */

export type OrchestrationStrategy = 'single' | 'multi_agent' | 'state_machine' | 'dag';

/**
 * 多 Agent 编排（占位）
 *
 * 设计思路：
 * - 一个 Orchestrator Agent 管理多个 Worker Agent
 * - Worker 之间通过消息队列通信
 * - Orchestrator 负责任务分解、结果汇聚、冲突解决
 */
export class MultiAgentOrchestrator {
  // TODO: 实现
}

/**
 * 状态机编排（占位）
 *
 * 设计思路：
 * - 定义状态和转换条件
 * - 每个状态可以绑定不同的 Agent 配置
 * - 支持人工审批节点
 */
export class StateMachineOrchestrator {
  // TODO: 实现
}
