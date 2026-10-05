/**
 * VectorAnn — 无 sqlite-vec 时的近似候选裁剪（IVF-lite 桶分区）
 *
 * 目标：把 JS 余弦从 O(全库) 降到 O(候选桶)。桶 = 向量粗量化哈希；
 * 查询先扫同桶，不足再扩桶，最后才全扫。sqlite-vec 可用时仍优先 KNN。
 * Index 非权威：bucket 可由 embedding 重算重建。
 */

import { cosineSimilarity } from '../memory/sqlite/vector-search.js';

/** 桶数（256：粗量化后碰撞可控，SQL IN 列表也短） */
export const VECTOR_BUCKETS = 256;

/**
 * 向量 → 桶 id（粗量化：取前若干维 × 8 档，混合成 0..255）
 *
 * @param embedding - 浮点向量
 */
export function vectorBucket(embedding: number[] | Float32Array): number {
  if (!embedding?.length) return 0;
  const n = Math.min(8, embedding.length);
  let h = 0;
  for (let i = 0; i < n; i++) {
    // 量化到 [-4, 3] 共 8 档，降低浮点噪声
    const q = Math.max(-4, Math.min(3, Math.floor(Number(embedding[i]) * 2)));
    h = (h * 8 + (q + 4)) & 0xff;
  }
  return h;
}

/** 查询侧：主桶 + 邻桶（汉明距离 1 的 8 个变体） */
export function queryBuckets(embedding: number[]): number[] {
  const primary = vectorBucket(embedding);
  const out = new Set<number>([primary]);
  for (let bit = 0; bit < 8; bit++) {
    out.add(primary ^ (1 << bit));
  }
  return [...out];
}

export interface AnnCandidateRow {
  id: string;
  embedding: number[] | null;
}

export interface AnnScoredHit {
  id: string;
  score: number;
}

/**
 * 桶裁剪 + 余弦打分（不加载 text）
 *
 * @param queryEmbedding - 查询向量
 * @param rows - 候选行（调用方已按 sourceIds 过滤；可先按 bucket 预取）
 * @param limit - top-k
 * @returns 按分数降序的 id+score
 */
export function scoreAnnCandidates(
  queryEmbedding: number[],
  rows: AnnCandidateRow[],
  limit: number,
): AnnScoredHit[] {
  const hits: AnnScoredHit[] = [];
  for (const row of rows) {
    const emb = row.embedding;
    if (!emb?.length || emb.length !== queryEmbedding.length) continue;
    const sim = cosineSimilarity(queryEmbedding, emb);
    if (sim <= 0) continue;
    hits.push({ id: row.id, score: sim });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * 由桶分组排序候选：主桶优先，再邻桶，最后其余（供分阶段扫）
 *
 * @param queryEmbedding - 查询向量
 * @param bucketOf - chunkId → bucket
 * @returns 按优先级排序的 bucket id 列表
 */
export function bucketScanOrder(queryEmbedding: number[]): number[] {
  return queryBuckets(queryEmbedding);
}
