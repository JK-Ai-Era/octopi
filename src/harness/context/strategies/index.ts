/**
 * Context 压缩策略
 *
 * 提供多种消息压缩策略，用于处理长对话场景。
 */

export { slidingWindow, createSlidingWindowCompressor } from './sliding-window.js';
export type { CompressionConfig, CompressionResult } from './sliding-window.js';

export { summarize, createSummarizeCompressor } from './summarize.js';
export type { SummarizeConfig } from './summarize.js';
