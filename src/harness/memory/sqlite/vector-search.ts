/**
 * Vector Search — 向量检索工具
 *
 * 当前使用 JavaScript cosine similarity 实现。
 * 未来可替换为 sqlite-vec 原生扩展以提升性能。
 *
 * @module
 */

/**
 * 计算两个向量的余弦相似度
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('Vector dimensions must match');

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dot / denominator;
}

/**
 * 计算余弦距离（1 - 相似度，范围 [0, 2]）
 */
export function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

export interface VectorSearchResult<T> {
  item: T;
  distance: number;
}

/**
 * 从候选集中按向量距离检索 top-K
 *
 * @param query - 查询向量
 * @param candidates - 候选集，每个元素包含 embedding 和原始数据
 * @param k - 返回数量
 * @param maxDistance - 最大距离阈值（超过则不返回）
 * @returns 按距离升序排列的结果
 */
export function searchTopK<T>(
  query: number[],
  candidates: Array<{ embedding: number[]; item: T }>,
  k: number,
  maxDistance?: number,
): VectorSearchResult<T>[] {
  const results: VectorSearchResult<T>[] = [];

  for (const candidate of candidates) {
    const distance = cosineDistance(query, candidate.embedding);
    if (maxDistance !== undefined && distance > maxDistance) continue;
    results.push({ item: candidate.item, distance });
  }

  results.sort((a, b) => a.distance - b.distance);
  return results.slice(0, k);
}

/**
 * 解析存储在数据库中的 embedding 字符串
 */
export function parseEmbedding(stored: string | null): number[] | null {
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

/**
 * 将 embedding 序列化为存储字符串
 */
export function serializeEmbedding(embedding: number[]): string {
  return JSON.stringify(embedding);
}
