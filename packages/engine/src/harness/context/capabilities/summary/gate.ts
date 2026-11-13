/**
 * 门控与 L1 截断
 *
 * @module harness/context/capabilities/summary/gate
 */

import { estimateTextTokens } from '../../token-estimate-fns.js';
import type { ContentUnit, L1KeepMode, SummaryGateConfig } from './types.js';

export const DEFAULT_GATE: Required<Pick<SummaryGateConfig, 'minTokens' | 'minBytes' | 'respectPolicyBudget'>> = {
  minTokens: 6000,
  minBytes: 24000,
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
  /**
   * 实际生效的保留策略
   *
   * `head`/`tail`/`both` 原样回传；未声明时按缺省解析为 `head`。
   * 调用方可据此判断「被省略的是哪一端」，无需自己推断。
   */
  keep: L1KeepMode;
}

/**
 * L1 硬顶截断 + 可操作占位
 *
 * `maxChars` 约束**进入 LLM 的最终字符串总长**（正文 + 截断说明 + 续读提示）。
 * 空间不足时优先保留完整 hint（可操作性），正文可为 0。
 *
 * `keep` 决定保留区段：
 *
 * - `head`——保留开头。既有行为，缺省。
 * - `tail`——保留结尾。用于「结论在末尾」的输出（测试汇总、退出信息、日志尾）。
 * - `both`——保头 + 保尾 + 中间省略标记。用于「开头上下文、末尾结论」的混合输出。
 *
 * 三种模式下正文配额相同（`maxChars` 减去通知文本），只是分配方式不同；
 * `both` 各取一半，余数给头部（头部通常承载「这是什么」的语境）。
 *
 * @param raw - 原文或 L2 结果
 * @param maxChars - 最终返回给 LLM 的最大字符数
 * @param hint - 续读提示
 * @param keep - 保留策略（缺省 `head`）
 * @returns 截断结果
 */
export function applyL1Truncate(
  raw: string,
  maxChars: number,
  hint: string,
  keep: L1KeepMode = 'head',
): L1TruncateResult {
  const rawLength = raw.length;
  if (rawLength <= maxChars) {
    return { text: raw, truncated: false, rawLength, keep };
  }

  const headNotice = (shown: number) =>
    `[truncated: showing first ${shown} of ${rawLength} chars] ${hint}`;

  if (keep === 'tail') {
    const tailNotice = (shown: number) =>
      `[truncated: showing last ${shown} of ${rawLength} chars] ${hint}`;
    // 在总长约束下取最大的 shown，使 notice + '\n' + tail ≤ maxChars
    for (let shown = Math.min(rawLength, maxChars); shown >= 0; shown--) {
      const candidate = `${tailNotice(shown)}\n${raw.slice(rawLength - shown)}`;
      if (candidate.length <= maxChars) {
        return { text: candidate, truncated: true, rawLength, keep };
      }
    }
    const fallback = tailNotice(0);
    return {
      text: fallback.length <= maxChars ? fallback : fallback.slice(0, maxChars),
      truncated: true,
      rawLength,
      keep,
    };
  }

  if (keep === 'both') {
    const bothNotice = (head: number, tail: number) =>
      `[truncated: showing first ${head} + last ${tail} of ${rawLength} chars, ${rawLength - head - tail} omitted] ${hint}`;
    // 通知文本比 head 模式长（含两段计数与省略量），先按最坏情况预留，再放大配额
    for (let total = Math.min(rawLength, maxChars); total >= 0; total--) {
      const head = Math.ceil(total / 2);
      const tail = total - head;
      const candidate = `${raw.slice(0, head)}\n${bothNotice(head, tail)}\n${raw.slice(rawLength - tail)}`;
      if (candidate.length <= maxChars) {
        return { text: candidate, truncated: true, rawLength, keep };
      }
    }
    const fallback = bothNotice(0, 0);
    return {
      text: fallback.length <= maxChars ? fallback : fallback.slice(0, maxChars),
      truncated: true,
      rawLength,
      keep,
    };
  }

  // 在总长约束下取最大的 shown，使 head + '\n' + notice ≤ maxChars
  for (let shown = Math.min(rawLength, maxChars); shown >= 0; shown--) {
    const candidate = `${raw.slice(0, shown)}\n${headNotice(shown)}`;
    if (candidate.length <= maxChars) {
      return { text: candidate, truncated: true, rawLength, keep };
    }
  }

  // 极小 maxChars：至少保留可操作 hint（必要时截断 hint 本身）
  const fallback = headNotice(0);
  return {
    text: fallback.length <= maxChars ? fallback : fallback.slice(0, maxChars),
    truncated: true,
    rawLength,
    keep,
  };
}
