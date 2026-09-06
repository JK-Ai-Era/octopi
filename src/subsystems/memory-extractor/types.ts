/**
 * Memory Extractor Subsystem — 本地类型定义
 *
 * 子系统内部使用的配置和注入类型。
 *
 * @module subsystems/memory-extractor/types
 */

import type { MemoryStore } from '../../harness/memory/types.js';
import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type { ThresholdPolicy } from './policies/threshold.js';
import type { LLMEnrichmentConfig } from './llm-enrichment.js';

// ── 注入依赖名称常量 ──

export const DEP_MEMORY_STORE = 'memoryStore';
export const DEP_MODEL_PROVIDER = 'modelProvider';
export const DEP_CONFIG = '__subsystem_config__';

// ── 注入依赖映射（类型安全） ──

export interface MemoryExtractorDeps {
  memoryStore: MemoryStore;
  modelProvider?: ModelProvider;
}

// ── Handler 配置 ──

export interface MemoryExtractorConfig {
  /** 最低置信度阈值（静态兜底，默认 0.6） */
  minConfidence?: number;
  /** 最低重要性阈值（静态兜底，默认 0.6） */
  minImportance?: number;
  /** 动态阈值策略（可选，默认使用内置策略） */
  thresholdPolicy?: ThresholdPolicy;
  /** Agent profile 名称（传入阈值策略做多场景复用） */
  agentProfile?: string;
  /** LLM 语义增强配置（可选，未配置则跳过 LLM 步骤） */
  llmEnrichment?: LLMEnrichmentConfig;
}

export const DEFAULT_CONFIG: MemoryExtractorConfig = {
  minConfidence: 0.6,
  minImportance: 0.6,
};
