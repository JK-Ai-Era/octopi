/**
 * F 类反馈环（arch/overflow-redesign.md T2②③）
 *
 * 长度类 400 的处理次序（错误分类是命门——只有 isContextLengthErrorText
 * 判中的 400 才会走到这里）：
 *
 * ② 真值回填（side effect，非主路径依赖）：错误文本带 provider 报告的窗口
 *    上限 → 登记 per-model 真值（window-truth.ts，测量 > 配置预测）+ 更新
 *    run 快照 → 下次装配前馈直接用新值（红线 3）。
 * ③ 提取不到 → 收缩上界：min(上次成功请求实测, 已知值×0.7)；缺一边时用
 *    存在的一边（只有实测 → 实测；只有已知值 → ×0.7）。收缩是保守猜测，
 *    只写 run 级快照（source:'shrunk'），**不入真值表**——猜测持久化会永久削窗。
 *
 * ④ 机械压缩不在此处：retry 重跑迭代 → transformContext 重新装配 → fits
 *    判据对新上界失效 → P1 收敛阶梯自动砍（守门=发送同一产物）。
 *
 * 收缩上界写入后粘滞整个 run（ResolvedModel 是 run 级快照）；后续若同 run
 * 再遇 400 且文本带真值，②的真值会覆盖收缩值。
 *
 * 复利语义：「已知值×0.7」里的已知值 = 当前 run 快照值，因此第二次收缩是在
 * 上一次收缩值上再 ×0.7（200k→140k→98k）。方向保守（宁小勿大）——「防砍
 * 不给力连环 400」优先于容量浪费；重发限 2 兜底。
 *
 * @module harness/run/reliability/context-length-feedback
 */

import type { ClassifiedError } from '@octopi-agent/core/interfaces/error-strategy.js';
import { extractContextWindowLimit, collectErrorText } from '@octopi-agent/core/loop/error-classifier.js';
import { getResolvedModel, updateResolvedModel } from '../model/run-scope.js';
import { recordWindowTruth } from '../model/window-truth.js';

/** 反馈结果 */
export interface ContextLengthFeedbackResult {
  /** backfilled=真值回填；shrunk=收缩上界；noop=两者皆无可写 */
  action: 'backfilled' | 'shrunk' | 'noop';
  /** 生效的窗口上界（noop 时 undefined） */
  bound?: number;
  /** 提取到的 provider 真值（仅 backfilled） */
  measured?: number;
}

/** 收缩公式输入 */
export interface ShrinkInput {
  /** 上次成功请求实测 prompt tokens（provider usage 真值） */
  lastSuccessActual?: number;
  /** 已知窗口值（config 或此前的真值/收缩值） */
  knownWindow?: number;
}

/**
 * T2③ 收缩上界计算（纯函数）。
 *
 * `min(上次成功请求实测, 已知值×0.7)`；缺一边时用存在的一边；全缺 → undefined
 * （无可收缩依据——重发原样必然再 400，由重发限 2 收口）。
 *
 * @param input - 上次成功实测 + 已知窗口
 * @returns 收缩后的窗口上界；无法收缩时 undefined
 */
export function computeShrunkWindowBound(input: ShrinkInput): number | undefined {
  const candidates: number[] = [];
  if (input.lastSuccessActual != null && input.lastSuccessActual > 0) {
    candidates.push(input.lastSuccessActual);
  }
  if (input.knownWindow != null && input.knownWindow > 0) {
    candidates.push(input.knownWindow * 0.7);
  }
  if (candidates.length === 0) return undefined;
  return Math.floor(Math.min(...candidates));
}

/**
 * 应用 F 类反馈（onError 链路上的 side effect）。
 *
 * 读取当前 run 的 ResolvedModel 快照：②真值 → 登记 + 快照换 `measured`；
 * ③收缩 → 快照换 `shrunk`。无 run 快照（非 resolved run）时无 ref 可登记、
 * 无快照可更新——如实返回 noop（side effect 丢失，下次 400 再走一遍）。
 *
 * @param error - 已分类错误（须为 context_length 才有意义）
 * @param opts.lastSuccessActual - 上次成功请求实测 prompt tokens
 * @returns 反馈结果（含生效上界，供审计/告警）
 */
export function applyContextLengthFeedback(
  error: ClassifiedError,
  opts: { lastSuccessActual?: number } = {},
): ContextLengthFeedbackResult {
  const text = collectText(error);

  // ② 真值回填：provider 报告的窗口上限
  const measured = extractContextWindowLimit(text);
  const snapshot = getResolvedModel();
  if (measured != null && snapshot) {
    recordWindowTruth(snapshot.ref, measured);
    // 「contextWindow 配置漂移/缺失」告警（T2⑥，正式告警通道 P3）：真值与
    // 配置不一致或原配置缺失 = 配置病，必须运维可见
    if (snapshot.contextWindow !== measured) {
      console.warn(
        `[overflow] contextWindow truth backfill: ref=${snapshot.ref} configured=${snapshot.contextWindow ?? 'missing'} measured=${measured} (config drift/missing)`,
      );
    }
    updateResolvedModel({
      ...snapshot,
      contextWindow: measured,
      source: 'measured',
      known: true,
    });
    return { action: 'backfilled', bound: measured, measured };
  }

  // ③ 收缩上界：保守猜测，只写 run 快照
  const shrunk = computeShrunkWindowBound({
    lastSuccessActual: opts.lastSuccessActual,
    knownWindow: snapshot?.contextWindow,
  });
  if (shrunk != null && snapshot) {
    console.warn(
      `[overflow] contextWindow shrink: ref=${snapshot.ref} known=${snapshot.contextWindow ?? 'missing'} lastSuccessActual=${opts.lastSuccessActual ?? 'missing'} -> bound=${shrunk}`,
    );
    updateResolvedModel({
      ...snapshot,
      contextWindow: shrunk,
      source: 'shrunk',
      known: true,
    });
    return { action: 'shrunk', bound: shrunk };
  }

  return { action: 'noop' };
}

/** 错误文本：与分类器同源（复用 collectErrorText，支持普通对象 / cause / code） */
function collectText(error: ClassifiedError): string {
  const fromOriginal = collectErrorText(error.originalError);
  // `message` 对对象型错误会被抹成 "[object Object]"，此时只信原始对象文本
  if (error.message && !error.message.startsWith('[object ')) {
    return `${error.message}\n${fromOriginal}`;
  }
  return fromOriginal;
}
