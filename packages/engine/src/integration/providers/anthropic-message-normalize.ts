/**
 * Anthropic Messages 线上编码归一化
 *
 * 背景（2026-11-12）：引擎的历史形态天然会产生**连续 user** 消息——`tool_result` 块
 * 后面接摘要占位、摘要占位后接 `turn_start`、`turn_end` 后接 `turn_start`。实测一个
 * 765 条消息的会话里有 17 处。Anthropic 官方会把连续同角色合并，但严格端点（火山等
 * anthropic-messages 代理）只回通用 InvalidParameter，不指出 param，排查成本极高。
 *
 * @module integration/providers/anthropic-message-normalize
 */

/**
 * 合并相邻同角色消息（Anthropic Messages 要求 user/assistant 交替）。
 *
 * 只动**线上编码**，不改变语义顺序：同角色的 content 块按原顺序拼接。非合并位置保持
 * 原有形态（纯文本消息仍是字符串），把字节变化限制在真正需要合并的点。
 *
 * @param messages - 已转换的 Anthropic 消息（role + content）
 * @returns 角色交替的消息列表（新数组，输入不被修改）
 */
export function mergeConsecutiveSameRole(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    const last = result[result.length - 1];
    if (!last || last.role !== msg.role) {
      result.push({ ...msg });
      continue;
    }
    // 同角色相邻：content 统一成块数组后拼接（字符串视作单个 text 块）
    last.content = [...toContentBlocks(last.content), ...toContentBlocks(msg.content)];
  }
  return result;
}

/**
 * content 归一化为块数组
 *
 * @param content - Anthropic content（字符串 / 块数组 / 空）
 * @returns 块数组（空内容 → 空数组）
 */
function toContentBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  if (content == null) return [];
  return [{ type: 'text', text: String(content) }];
}
