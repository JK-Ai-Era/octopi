/**
 * Token 估算器
 *
 * 提供统一的 token 数量估算，供 Core 和 Harness 层使用。
 *
 * 估算策略（基于 tiktoken cl100k_base 经验值）：
 * - 英文：~1 token per 4 chars（含空格）
 * - 中文：~1.5 token per 字（UTF-8 多字节编码）
 * - JSON/代码：~1 token per 3 chars（结构符号多）
 * - 总体：混合内容用加权平均
 *
 * 注意：这是估算，不是精确计算。生产环境应使用 tiktoken。
 */

/**
 * 估算 LLM 消息列表的 token 数
 */
export function estimateTokens(messages: Array<{ content?: string | null; role?: string }>): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string' && msg.content.length > 0) {
      total += estimateTextTokens(msg.content);
    }
  }
  return total;
}

/**
 * 估算单段文本的 token 数
 *
 * 使用采样策略：超长文本采样前 2000 字符估算，避免 O(n) 扫描。
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;

  // 超长文本采样
  const sample = text.length > 2000 ? text.slice(0, 2000) : text;
  const sampleRatio = text.length / sample.length;

  // 分类统计
  let chineseChars = 0;
  let asciiChars = 0;
  let otherChars = 0;

  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) {
      // CJK 统一汉字
      chineseChars++;
    } else if (code < 0x80) {
      // ASCII
      asciiChars++;
    } else {
      otherChars++;
    }
  }

  // 估算：
  // - 中文：~1.5 token/字
  // - 英文：~0.25 token/char（即 4 chars/token）
  // - 其他：~0.5 token/char
  const tokens = chineseChars * 1.5 + asciiChars * 0.25 + otherChars * 0.5;

  // 加上采样比例
  return Math.ceil(tokens * sampleRatio);
}

/**
 * 估算工具调用 JSON 的 token 数
 *
 * 工具调用的 JSON 结构符号多，token 密度更高。
 */
export function estimateToolCallTokens(toolCalls: Array<{ name?: string; arguments?: unknown }>): number {
  let total = 0;
  for (const tc of toolCalls) {
    // 函数名：~1 token
    total += 1;
    // 参数 JSON：结构符号密集，~3 chars/token
    const argsStr = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {});
    total += Math.ceil(argsStr.length / 3);
  }
  return total;
}
