/**
 * Session 域 — 会话连续性聚合（Continuity）
 *
 * 拥有：Session / Discourse / Projection / Compact 状态 / SessionTask
 * 子模块：tasks（会话任务）、history（历史检索）
 */
export * from './types.js';
export * from './compact.js';
export * from './state-machine.js';
export * from './tasks/index.js';
export * from './history/index.js';
