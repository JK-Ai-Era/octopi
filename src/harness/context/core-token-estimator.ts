/**
 * Token 估算器
 *
 * 提供统一的 token 数量估算，供 Core 和 Harness 层使用。
 *
 * 三层策略（参考 OpenClaw）：
 * 1. 优先使用 LLM 返回的实际 token 数（外部回写）
 * 2. 次选：专用 tokenizer（如 tiktoken）- 未来扩展
 * 3. 兜底：启发式估算，按内容类型使用不同比率
 *
 * 关键改进（v0.6.5+）：
 * - 完整 CJK 范围检测（扩展A/B + 平假名 + 片假名 + 韩文 + 全角）
 * - 按内容类型区分比率（文本4/工具结果2/JSON3）
 * - 消息结构开销 12 token
 * - 图片估算 1200 token
 */

import {
  CHARS_PER_TOKEN,
  TOOL_RESULT_CHARS_PER_TOKEN,
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
 * 估算 LLM 消息列表的 token 数
 *
 * 支持 string 和 ContentBlock[] 两种 content 格式。
 * 包含消息结构开销。
 */
export function estimateTokens(messages: Array<{ content?: string | unknown[] | null; role?: string }>): number {
  let total = 0;
  for (const msg of messages) {
    // 消息结构开销
    total += MESSAGE_OVERHEAD_TOKENS;

    if (typeof msg.content === 'string' && msg.content.length > 0) {
      total += estimateTextTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          total += estimateTextTokens(b.text);
        } else if (b.type === 'image') {
          total += IMAGE_TOKEN_ESTIMATE;
        } else if (b.type === 'audio') {
          total += AUDIO_TOKEN_ESTIMATE;
        } else if (b.type === 'video') {
          total += VIDEO_TOKEN_ESTIMATE;
        } else {
          total += 10; // 其他块类型
        }
      }
    }
  }
  return total;
}

/**
 * 估算工具调用 JSON 的 token 数
 *
 * 工具调用的 JSON 结构符号多，token 密度更高。
 */
export function estimateToolCallTokens(toolCalls: Array<{ name?: string; arguments?: unknown }>): number {
  let total = 0;
  for (const tc of toolCalls) {
    // 函数名
    total += estimateTextTokens(tc.name ?? '');
    // 参数 JSON：用 JSON_CHARS_PER_TOKEN
    const argsStr = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {});
    total += Math.ceil(argsStr.length / JSON_CHARS_PER_TOKEN);
  }
  return total;
}
