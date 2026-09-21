/**
 * Oversized 输入管道
 *
 * @module harness/capabilities/summary/oversized
 */

import { estimateTextTokens } from '../../context/token-estimate-fns.js';
import type { OversizedPolicy, SummaryCoverage } from './types.js';

export interface ChunkPlan {
  chunks: string[];
  overlapTokens: number;
  /** 是否已覆盖全文（maxChunks 提前截断时为 false） */
  complete: boolean;
}

/**
 * 按 token 预算切分文本
 *
 * @param text - 输入
 * @param inputBudget - 每块最大 token
 * @param overlapTokens - 块重叠（token 估算）
 * @param maxChunks - 最大块数
 * @returns 切分计划
 */
export function planChunks(
  text: string,
  inputBudget: number,
  overlapTokens: number,
  maxChunks: number,
): ChunkPlan {
  const totalTokens = estimateTextTokens(text);
  if (totalTokens <= inputBudget || inputBudget <= 0) {
    return { chunks: [text], overlapTokens: 0, complete: true };
  }

  const charsPerToken = Math.max(1, Math.ceil(text.length / Math.max(1, totalTokens)));
  const chunkChars = Math.max(200, Math.floor(inputBudget * charsPerToken));
  const overlapChars = Math.floor(overlapTokens * charsPerToken);

  const chunks: string[] = [];
  let i = 0;
  let reachedEnd = false;
  while (i < text.length && chunks.length < maxChunks) {
    const end = Math.min(text.length, i + chunkChars);
    chunks.push(text.slice(i, end));
    if (end >= text.length) {
      reachedEnd = true;
      break;
    }
    i = Math.max(i + 1, end - overlapChars);
  }
  const complete = reachedEnd || (chunks.length > 0 && i >= text.length);
  return { chunks, overlapTokens, complete };
}

/**
 * 合并块级摘要
 *
 * @param parts - 各块摘要
 * @returns 合并文本
 */
export function mergeChunkSummaries(parts: string[]): string {
  return parts.map((p, idx) => `### Part ${idx + 1}\n${p}`).join('\n\n');
}

/**
 * 根据 oversized 策略与块处理情况推导 coverage
 *
 * @param policy - oversized 策略
 * @param processed - 已处理块数
 * @param plan - 切分计划（含 complete）
 * @param usedWindow - 是否走了 window
 * @param usedTruncate - 是否截断兜底
 * @returns coverage
 */
export function coverageFromOversized(
  policy: OversizedPolicy,
  processed: number,
  plan: { chunks: string[]; complete: boolean },
  usedWindow: boolean,
  usedTruncate: boolean,
): SummaryCoverage {
  if (usedTruncate) return 'truncated';
  if (usedWindow) return 'windowed';
  const total = plan.chunks.length;
  if (total <= 1 && plan.complete) return 'full';
  // 未切完全文，或块未全部处理完 → partial（onPartial=accept 不得把残缺标成 full）
  if (!plan.complete || processed < total) return 'partial';
  return 'full';
}

/**
 * onPartial=reject 时是否应拒绝返回残缺结果
 *
 * @param policy - oversized 策略
 * @param coverage - 实际 coverage
 * @returns true 表示调用方应视为失败
 */
export function shouldRejectPartial(policy: OversizedPolicy, coverage: SummaryCoverage): boolean {
  return policy.onPartial === 'reject' && coverage !== 'full' && coverage !== 'windowed';
}
