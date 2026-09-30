/**
 * Memory 写入去重 — 归一化 + 字符 3-gram
 *
 * 写路径 G5 初判（duplicate / 近重复可 supersede）；govern supersede 复用同一公式。
 * **不用关键词猜语义/极性**（意图不进正则，见 docs/memory.md）。
 *
 * @module harness/memory/similarity
 */

import type { MemoryEntry, MemoryType } from './types.js';

export function normalizedProposition(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[「」“”"'`]/g, '')
    .replace(/[。！？!?.;；,，]/g, '')
    .trim();
}

/** 字符 3-gram Jaccard 相似度 */
export function charTrigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = s.replace(/\s+/g, '');
    const set = new Set<string>();
    if (t.length < 3) {
      if (t) set.add(t);
      return set;
    }
    for (let i = 0; i <= t.length - 3; i++) set.add(t.slice(i, i + 3));
    return set;
  };
  const sa = grams(a);
  const sb = grams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface FindDuplicateOptions {
  /** 相似度阈值，默认 0.92 */
  similarity?: number;
  /** 排除 id（如 supersedes 目标） */
  excludeId?: string;
}

export interface DuplicateHit {
  id: string;
  content: string;
  similarity: number;
  /** 归一化后全等 */
  exact: boolean;
}

/**
 * 在存活条目中查找与候选同 type 的重复/近重复命题。
 * 归一化全等 → similarity=1, exact=true；否则 trigram Jaccard。
 */
export function findDuplicate(
  live: Array<Pick<MemoryEntry, 'id' | 'type' | 'content' | 'deleted'>>,
  candidate: { type: MemoryType; proposition: string },
  options?: FindDuplicateOptions,
): DuplicateHit | null {
  const threshold = options?.similarity ?? 0.92;
  const na = normalizedProposition(candidate.proposition);
  if (!na) return null;
  let best: DuplicateHit | null = null;
  for (const e of live) {
    if (e.deleted) continue;
    if (options?.excludeId && e.id === options.excludeId) continue;
    if (e.type !== candidate.type) continue;
    const nb = normalizedProposition(e.content);
    const exact = na === nb;
    const similarity = exact ? 1 : charTrigramSimilarity(na, nb);
    if (similarity < threshold) continue;
    if (!best || similarity > best.similarity) {
      best = { id: e.id, content: e.content, similarity, exact };
    }
  }
  return best;
}
