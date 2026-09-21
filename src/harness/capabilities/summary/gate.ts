/**
 * 门控与 L1 截断
 *
 * @module harness/capabilities/summary/gate
 */

import { estimateTextTokens } from '../../context/token-estimate-fns.js';
import type { ContentUnit, SummaryGateConfig } from './types.js';

export const DEFAULT_GATE: Required<Pick<SummaryGateConfig, 'minTokens' | 'minBytes' | 'respectPolicyBudget'>> = {
  minTokens: 2000,
  minBytes: 8000,
  respectPolicyBudget: true,
};

/**
 * 合并 gate 配置
 *
 * @param parts - 可覆盖片段（后者优先）
 * @returns 完整 gate
 */
export function mergeGate(...parts: Array<SummaryGateConfig | undefined>): SummaryGateConfig {
  return { ...DEFAULT_GATE, ...parts.filter(Boolean).reduce((a, b) => ({ ...a, ...b }), {}) };
}

/**
 * 判断是否应触发 L2 摘要
 *
 * `respectPolicyBudget`：门控与 policy 预算的关系。当前实现中超过 policy 输入预算的内容
 * **仍应处理**（由 oversized 切块），因此该开关不在此处拒绝；保留字段以兼容配置 schema。
 *
 * @param unit - 内容单元
 * @param gate - 门控配置
 * @param _policyMaxInputTokens - 当前 policy 输入预算（文档用；超预算交 oversized）
 * @returns true 表示应调用 extract
 */
export function shouldProcessUnit(
  unit: ContentUnit,
  gate: SummaryGateConfig,
  _policyMaxInputTokens?: number,
): boolean {
  const g = mergeGate(gate);
  const bytes = unit.source.sizeBytes ?? Buffer.byteLength(unit.text, 'utf-8');
  const tokens = estimateTextTokens(unit.text);
  return tokens >= (g.minTokens ?? 0) || bytes >= (g.minBytes ?? 0);
}

export interface L1TruncateResult {
  text: string;
  truncated: boolean;
  rawLength: number;
}

/**
 * L1 硬顶截断 + 可操作占位
 *
 * `maxChars` 约束**进入 LLM 的最终字符串总长**（正文 + 截断说明 + 续读提示）。
 * 空间不足时优先保留完整 hint（可操作性），正文可为 0。
 *
 * @param raw - 原文或 L2 结果
 * @param maxChars - 最终返回给 LLM 的最大字符数
 * @param hint - 续读提示
 * @returns 截断结果
 */
export function applyL1Truncate(raw: string, maxChars: number, hint: string): L1TruncateResult {
  const rawLength = raw.length;
  if (rawLength <= maxChars) {
    return { text: raw, truncated: false, rawLength };
  }

  const notice = (shown: number) =>
    `[truncated: showing first ${shown} of ${rawLength} chars] ${hint}`;

  // 在总长约束下取最大的 shown，使 head + '\n' + notice ≤ maxChars
  for (let shown = Math.min(rawLength, maxChars); shown >= 0; shown--) {
    const candidate = `${raw.slice(0, shown)}\n${notice(shown)}`;
    if (candidate.length <= maxChars) {
      return { text: candidate, truncated: true, rawLength };
    }
  }

  // 极小 maxChars：至少保留可操作 hint（必要时截断 hint 本身）
  const fallback = notice(0);
  return {
    text: fallback.length <= maxChars ? fallback : fallback.slice(0, maxChars),
    truncated: true,
    rawLength,
  };
}
