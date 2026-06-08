/**
 * Multi-Agent 模块统一导出
 *
 * 多 Agent 编排、注册、发现。
 */

// ── 类型 ──
export type {
  SwarmTopology,
  SwarmConfig,
  SwarmAgent,
  SwarmTask,
} from './types.js';
export { SwarmEvents } from './types.js';

// ── 注册表 ──
export { DefaultAgentRegistry } from './registry.js';

// ── 编排器 ──
export { AgentSwarm } from './swarm.js';
export type { OrchestrationStrategy } from './swarm.js';
export {
  RoundRobinStrategy,
  CapabilityStrategy,
  PipelineStrategy,
} from './swarm.js';
