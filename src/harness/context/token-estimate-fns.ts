/**
 * Token 估算纯函数（Harness 内部原语）
 *
 * 不依赖 Message / LLMMessage 等领域类型，只做「内容 → token 数」。
 * 由 `token-estimator.ts` 组装为 `TokenEstimator` 实现，也可被同层模块直接复用。
 *
 * 三层策略（参考 OpenClaw）：
 * 1. 优先使用 LLM 返回的实际 token 数（外部回写）
 * 2. 次选：专用 tokenizer（如 tiktoken）- 未来扩展
 * 3. 兜底：启发式估算，按内容类型使用不同比率
 */

import {
  CHARS_PER_TOKEN,
  JSON_CHARS_PER_TOKEN,
  MESSAGE_OVERHEAD_TOKENS,
  IMAGE_TOKEN_ESTIMATE,
  AUDIO_TOKEN_ESTIMATE,
  VIDEO_TOKEN_ESTIMATE,
  SAMPLE_THRESHOLD,
} from './token-constants.js';

// ── CJK 检测正则 ──
// 参考 OpenClaw 的 NON_LATIN_RE，覆盖完整东亚字符范围
const NON_LATIN_RE =
  /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\uFF01-\uFF60\uFFE0-\uFFE6]/gu;

// CJK 扩展 B+ 的 surrogate pairs（U+20000-U+2FA1F）
const CJK_SURROGATE_HIGH_RE = /[\uD840-\uD87E][\uDC00-\uDFFF]/g;

/**
 * CJK 感知的等效字符数计算
 *
 * 每个 CJK 字符计为 CHARS_PER_TOKEN 个等效字符，
 * 这样 `adjustedChars / CHARS_PER_TOKEN` 能得到准确的 token 估算。
 *
 * 参考 OpenClaw 的 estimateStringChars()。
 *
 * @param text 原始文本
 * @returns CJK 加权后的等效字符数
 */
export function estimateAdjustedChars(text: string): number {
  if (text.length === 0) return 0;

  const nonLatinCount = (text.match(NON_LATIN_RE) ?? []).length;
  // 修正 surrogate pairs（CJK 扩展 B+ 占 2 个 UTF-16 单元但算 1 个字符）
  const cjkSurrogates = (text.match(CJK_SURROGATE_HIGH_RE) ?? []).length;
  const codePointLength = text.length - cjkSurrogates;

  // CJK 字符本身已计入 codePointLength，额外加 (CHARS_PER_TOKEN - 1) 的权重
  return codePointLength + nonLatinCount * (CHARS_PER_TOKEN - 1);
}

/**
 * 估算单段文本的 token 数
 *
 * 使用 CJK 感知的等效字符数 + 采样策略。
 *
 * @param text 原始文本
 * @returns 估算 token 数
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;

  // 超长文本采样
  const sample = text.length > SAMPLE_THRESHOLD ? text.slice(0, SAMPLE_THRESHOLD) : text;
  const sampleRatio = text.length / sample.length;

  const adjustedChars = estimateAdjustedChars(sample);
  return Math.ceil((adjustedChars / CHARS_PER_TOKEN) * sampleRatio);
}

/**
 * 估算单个 content block 的 token 数
 *
 * 统一处理 text / image / audio（含 OpenAI 的 input_audio）/ video。
 *
 * @param block ContentBlock（至少含 type，text 块需含 text）
 * @returns 估算 token 数
 */
export function estimateContentBlock(block: { type?: string; text?: string }): number {
  if (block.type === 'text' && typeof block.text === 'string') {
    return estimateTextTokens(block.text);
  }
  if (block.type === 'image') return IMAGE_TOKEN_ESTIMATE;
  if (block.type === 'audio' || block.type === 'input_audio') return AUDIO_TOKEN_ESTIMATE;
  if (block.type === 'video') return VIDEO_TOKEN_ESTIMATE;
  return 10; // 其他块类型
}

/**
 * 估算工具调用 JSON 的 token 数
 *
 * 工具调用的 JSON 结构符号多，token 密度更高。
 * `arguments` 已是字符串时直接用长度，避免二次 JSON.stringify。
 *
 * @param toolCalls `{ name?, arguments? }` 形态的工具调用列表
 * @returns 估算 token 数
 */
export function estimateToolCallTokens(toolCalls: Array<{ name?: string; arguments?: unknown }>): number {
  let total = 0;
  for (const tc of toolCalls) {
    total += estimateTextTokens(tc.name ?? '');
    const argsStr = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {});
    total += Math.ceil(argsStr.length / JSON_CHARS_PER_TOKEN);
  }
  return total;
}

/**
 * 估算松散结构消息列表的 token 数
 *
 * 支持 string 和 ContentBlock[] 两种 content 格式，含消息结构开销。
 * 适用于无强类型 Message / LLMMessage 的调用方。
 *
 * @param messages `{ content?, role? }` 形态的消息列表
 * @returns 估算 token 数
 */
export function estimateTokens(messages: Array<{ content?: string | unknown[] | null; role?: string }>): number {
  let total = 0;
  for (const msg of messages) {
    total += MESSAGE_OVERHEAD_TOKENS;

    if (typeof msg.content === 'string' && msg.content.length > 0) {
      total += estimateTextTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        total += estimateContentBlock(block as { type?: string; text?: string });
      }
    }
  }
  return total;
}
