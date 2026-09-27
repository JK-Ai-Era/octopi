/**
 * 意图初判 — LLM 轻量分流（arch §6.3.1）
 *
 * 只决定「第一轮注入形态」；失败 fail-open → structure_tools。
 * 本期提供 plan 接口 + 规则兜底；LLM 调用点可注入（不绑死 Provider）。
 */

import type { AttachmentInjectPlan, SessionAttachment } from './types.js';

export interface AttachmentIntentInput {
  userText: string;
  attachments: SessionAttachment[];
  /** 各文件标题/开头摘要 */
  outlines?: Record<string, string>;
}

export type AttachmentIntentResolver = (
  input: AttachmentIntentInput,
) => Promise<AttachmentInjectPlan>;

/**
 * 确定性兜底（intent=off / LLM 失败）
 *
 * @param input - 用户正文 + 附件
 */
export function fallbackInjectPlan(input: AttachmentIntentInput): AttachmentInjectPlan {
  const text = input.userText.trim();
  if (!text) {
    return {
      mode: 'overview_tools',
      reason: 'empty user text; overview + tools',
    };
  }
  return {
    mode: 'structure_tools',
    focus: text.slice(0, 500),
    reason: 'fail-open; structure + tools + focus=user text',
  };
}

/**
 * 仅当「大文件 + 非空正文」时调用 resolver；否则走确定性规则
 *
 * @param input - 意图输入
 * @param opts - fullTextMaxChars + resolver + timeoutMs
 */
export async function resolveInjectPlan(
  input: AttachmentIntentInput,
  opts: {
    fullTextMaxChars: number;
    intent: 'llm' | 'off';
    timeoutMs?: number;
    resolver?: AttachmentIntentResolver;
  },
): Promise<AttachmentInjectPlan> {
  const text = input.userText.trim();
  const hasLarge = input.attachments.some(
    (a) => (a.parse?.chars ?? 0) > opts.fullTextMaxChars || a.sizeBytes > opts.fullTextMaxChars * 2,
  );

  // 空正文：确定性 overview（§6.5，不调 LLM）
  if (!text) {
    return fallbackInjectPlan(input);
  }
  // 小文件：全文，无需意图
  if (!hasLarge) {
    return { mode: 'full', reason: 'small extracts; full text' };
  }
  if (opts.intent === 'off' || !opts.resolver) {
    return fallbackInjectPlan(input);
  }

  const timeoutMs = opts.timeoutMs ?? 800;
  try {
    const plan = await withTimeout(opts.resolver(input), timeoutMs);
    if (!plan || !plan.mode) {
      return fallbackInjectPlan(input);
    }
    return plan;
  } catch {
    return fallbackInjectPlan(input);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('intent timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
