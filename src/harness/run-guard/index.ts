/**
 * run-guard 领域统一导出
 *
 * 过程监督：判断单次 run 是否跑飞（continue / recover / stop）。
 * 不读写 Session.tasks，不编排 Workflow。
 * AgentSupervisor 已归档（见 arch/agent-runtime.md §10）。
 */

export { DefaultRunGuard, createRunGuard } from './default-run-guard.js';
export type { RunGuardConfig } from './default-run-guard.js';
