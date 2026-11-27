/**
 * Cognition 召回种子 — 种子推导与双向匹配（CognitionLayer 与两个 ConceptGraphStore 共用单源）
 *
 * 切词复用记忆检索的分词内核（{@link tokenizeKeywordDetail}）——全库唯一一套切词语义；
 * 这里只承载概念召回的种子策略（强 token、上限、整句兜底）与匹配谓词。
 *
 * 单字概念名仅精确命中可召回（不参与包含/反向匹配，防单字误锚）。
 *
 * @module harness/memory/cognition-seeds
 */

import { tokenizeKeywordDetail } from './sqlite/keyword-search.js';

/**
 * 概念名归一（指纹与召回匹配共用；唯一实现，store 内不得另抄）。
 *
 * @param name - 原始概念名
 * @returns trim + 小写
 */
export function normName(name: string): string {
  return name.trim().toLowerCase();
}

export interface DeriveQuerySeedsOptions {
  /** 每个 token 最少字符数（默认 2，与分词内核一致） */
  minTokenLength?: number;
  /** 子句种子上限（默认 8；<1 按 1） */
  maxSeeds?: number;
}

/**
 * 从查询文本推导词面种子：空白/标点切分后的强 token（CJK 滑窗二元组不算种子，防误锚）。
 * 子句超上限时截断并**追加整句兜底种子**——句内任意位置直呼概念名的反向覆盖面不因截断丢失；
 * 切不出 token 时回退整句。
 *
 * @param query - 原始查询文本
 * @param options - 上限与最小长度
 * @returns 种子列表（截断时 ≤ maxSeeds + 1；空查询返回空数组）
 */
export function deriveQuerySeeds(query: string, options?: DeriveQuerySeedsOptions): string[] {
  const minLen = options?.minTokenLength ?? 2;
  const maxSeeds = Math.max(1, options?.maxSeeds ?? 8);
  const strong = tokenizeKeywordDetail(query).strong.filter((t) => t.length >= minLen);
  const whole = query.trim();
  if (strong.length > maxSeeds) {
    return [...strong.slice(0, maxSeeds), whole];
  }
  return strong.length ? strong : whole ? [whole] : [];
}

export type SeedMatcher = (name: string, description?: string | null, aliases?: readonly string[]) => boolean;

/**
 * 构造种子命中谓词（两个 store 实现共用，禁止各写一份）。
 *
 * 命中 = name 精确等于 token ｜ name 含 token ｜ token 含 name ｜ description 含 token。
 * 包含匹配要求「针」≥2 字（正向/描述＝token，反向＝name 归一后），防单字误锚；
 * 单字概念名仅精确命中可召回。
 *
 * @param seeds - 原始种子（内部经 {@link normName} 归一，空种子忽略）
 * @returns 命中谓词
 */
export function createSeedMatcher(seeds: readonly string[]): SeedMatcher {
  const keys = seeds.map((s) => normName(s)).filter((s) => s.length > 0);
  return (name, description, aliases) => {
    const nameKey = normName(name);
    for (const s of keys) {
      if (nameKey === s) return true;
      if (s.length >= 2 && nameKey.includes(s)) return true;
      if (nameKey.length >= 2 && s.includes(nameKey)) return true;
    }
    // 别名同规则命中（M-2：被折叠的长名可召回）
    for (const a of aliases ?? []) {
      const ak = normName(a);
      if (!ak) continue;
      for (const s of keys) {
        if (ak === s) return true;
        if (s.length >= 2 && ak.includes(s)) return true;
        if (ak.length >= 2 && s.includes(ak)) return true;
      }
    }
    if (!description) return false;
    const descKey = normName(description);
    return keys.some((s) => s.length >= 2 && descKey.includes(s));
  };
}
