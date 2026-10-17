/**
 * orchestration 领域统一导出（experimental）
 *
 * @layer harness/collaboration/orchestration
 *
 * **范围收窄记录**（`arch/delegation.md` §12.2）：
 * workflow / quality / strategy / planner / scheduler / async-task 已删除，
 * 由新的 Delegation 委派契约（`collaboration/delegation`）取代执行语义。
 * 保留：
 * - `reflector/` — LLMReflector（高置信模式改写 Memory `method`，被知识分馏链测试保护）
 * - `cognitive-loop.ts` — Planner/Reflector/ExecutionRecord/AgentState 契约
 *
 * 默认不进主路径；经 package 子路径 `octopi/harness/orchestration` 访问。
 */

// ── cognitive-loop 契约 ──
export type {
  Planner,
  Reflector,
  AgentState,
  AgentStats,
  Plan,
  PlanStep,
  StepResult,
  ExecutionRecord,
  Assessment,
  Pattern,
} from './cognitive-loop.js';

// ── Reflector ──
export { LLMReflector } from './reflector/index.js';
export type { LLMReflectorConfig } from './reflector/index.js';
