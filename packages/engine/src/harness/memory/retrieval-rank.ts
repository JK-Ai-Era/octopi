/**
 * Memory 检索排序与相关性地板
 *
 * 向量路径必须先过相似度地板再按「相关性 + 质量」混合排序；
 * 无命中时宁缺毋滥返回空，禁止用高 quality 无关条目填满 limit。
 *
 * @module harness/memory/retrieval-rank
 */

import type { MemoryEntry } from './types.js';

/** 向量路径默认最低余弦相似度（低于则丢弃） */
export const DEFAULT_MIN_SIMILARITY = 0.35;

/** 混合排序中相似度权重（其余给 quality = importance×confidence×decay） */
export const DEFAULT_SIMILARITY_WEIGHT = 0.65;

/** 关键词路径最低字段命中分（strong content=3 / weak content=1.5） */
/** 默认 3：strong 单命中可通过；仅 weak 二元组（×0.5）不足以过关 */
export const DEFAULT_MIN_KEYWORD_SCORE = 3;

/**
 * 记忆质量分（与相关性无关的「值不值得注入」）
 *
 * @param entry - 记忆条目
 * @returns importance × confidence × decayFactor，范围约 [0,1]
 */
export function qualityScore(entry: Pick<MemoryEntry, 'importance' | 'confidence' | 'decayFactor'>): number {
  return entry.importance * entry.confidence * entry.decayFactor;
}

/**
 * 混合排序分：相关性与质量线性加权
 *
 * @param similarity - 余弦相似度 [0,1]
 * @param quality - qualityScore
 * @param similarityWeight - 相似度权重 [0,1]
 * @returns 越大越优先
 */
export function blendRank(
  similarity: number,
  quality: number,
  similarityWeight: number = DEFAULT_SIMILARITY_WEIGHT,
): number {
  const w = Math.min(1, Math.max(0, similarityWeight));
  return w * similarity + (1 - w) * quality;
}

/**
 * 是否达到向量相关性地板
 *
 * @param similarity - 余弦相似度
 * @param minSimilarity - 地板；undefined 用默认
 */
export function passesSimilarityFloor(
  similarity: number,
  minSimilarity?: number,
): boolean {
  const floor = minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  return similarity >= floor;
}

/**
 * 解析检索相关性旋钮（query 覆盖 options / 默认）
 *
 * @param queryMin - MemoryQuery.minSimilarity
 * @param queryMinKeyword - MemoryQuery.minKeywordScore
 * @param optionsMin - store 选项 minSimilarity
 * @param optionsMinKeyword - store 选项 minKeywordScore
 */
export function resolveRetrievalKnobs(
  queryMin?: number,
  queryMinKeyword?: number,
  optionsMin?: number,
  optionsMinKeyword?: number,
): { minSimilarity: number; minKeywordScore: number } {
  return {
    minSimilarity: queryMin ?? optionsMin ?? DEFAULT_MIN_SIMILARITY,
    minKeywordScore: queryMinKeyword ?? optionsMinKeyword ?? DEFAULT_MIN_KEYWORD_SCORE,
  };
}
