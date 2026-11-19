import type { Message } from '@octopi-agent/core/types.js';
import {
  extractUserMessageText,
  formatTurnStartContent,
  isTurnStartContent,
} from '@octopi-agent/engine/harness/context/turn-envelope.js';

/** user-messages 投影的用户原文上限：消费方只做定位轨 tooltip 预览 */
export const USER_MESSAGE_PROJECTION_CHARS = 4000;

/**
 * user-messages 投影的 content 变换（turn 定位索引用）。
 *
 * engine 不变量「用户原文不得截断信封」：turn_start 正文的 `<user_message>` 段位于
 * turn_context（runtime_snapshot 等数千字符）之后，直接截断原始 content 会把信封结构
 * 裁断，web 层 `extractUserMessageText` 找不到 `<user_message>` 段将退化为原样返回
 * （定位轨预览显示信封原文而非用户输入）。正确做法：先用 engine 同源提取器取出用户
 * 原文、截断、再重新定形为合法 turn_start 信封（原文经转义嵌入，结构永不被破坏）。
 *
 * 非 turn_start 正文（`<turn_end/>` 锚点、机器条目）：字符串截断、其余原样——
 * 其隐藏判定（isChatReplayHidden 按 metadata.source）不受影响。
 */
export function projectUserMessageContent(content: unknown): Message['content'] {
  const asEnvelope = (
    typeof content === 'string' || Array.isArray(content) ? content : undefined
  ) as never;
  if (isTurnStartContent(asEnvelope)) {
    const text = extractUserMessageText(asEnvelope).slice(0, USER_MESSAGE_PROJECTION_CHARS);
    return formatTurnStartContent({ turnId: '', at: '', turnContextXml: '', userText: text });
  }
  return typeof content === 'string'
    ? content.slice(0, USER_MESSAGE_PROJECTION_CHARS)
    : (content as Message['content']);
}
