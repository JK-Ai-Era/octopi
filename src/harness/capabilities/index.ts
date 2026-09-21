/**
 * Harness 公用能力（capabilities）门面
 *
 * 横切可注入能力；不是 LLM 工具面，不计入业务领域口径。
 *
 * @module harness/capabilities
 */

export * from './summary/index.js';
export * from './compact/index.js';
export { createMemorySummaryCache } from './summary/memory-cache.js';
