/**
 * Context 组装公用能力门面（Summary / Compact）
 *
 * 横切可注入能力；不是 LLM 工具面，不计入业务领域口径。
 * 跨域文档抽取在 `harness/capabilities/document`（session/knowledge/tools 共用）。
 *
 * @module harness/context/capabilities
 */

export * from './summary/index.js';
export * from './compact/index.js';
export { createMemorySummaryCache } from './summary/memory-cache.js';
