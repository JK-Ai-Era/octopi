/**
 * Token 估算 adapter（内容形状 → Segment → 唯一计数）
 *
 * 不依赖 Message / LLMMessage 等领域类型，只做「内容形状 → token 数」。
 * 计数逻辑全部委托 {@link estimateSegments}（P1-c：单实现 + 两 adapter）；
 * 本模块是「松散形状」adapter，领域/LLM 两入口的形状归一在 `token-estimator.ts`。
 *
 * R4 红线：不得返回常数兜底——未知内容块按长度计（告警半项归 P2-a）。
 */

import {
  JSON_CHARS_PER_TOKEN,
  IMAGE_TOKEN_ESTIMATE,
  AUDIO_TOKEN_ESTIMATE,
  VIDEO_TOKEN_ESTIMATE,
} from './token-constants.js';
import { estimateSegments, textSegment, type Segment } from './token-segments.js';

/**
 * 估算单段文本的 token 数
 *
 * @param text 原始文本
 * @returns 估算 token 数
 */
export function estimateTextTokens(text: string): number {
  return estimateSegments([textSegment(text)]);
}

/**
 * 内容块 → Segment（分类归一；media 固定成本继承旧常量）
 *
 * 图像接受三种同价形态：原生 `image` 与转换后的 `image_url` / `input_image`
 * （convertMessage 产出 image_url——旧版漏认导致图像按 0 计）。
 * 未知块类型按实际载荷长度计（R4：无常数兜底）：正文走 CJK 分类文本口径；
 * 无正文按指针字段（name/url/src/path/filename）长度计——不序列化内嵌 base64
 * 载荷（会虚高），无载荷即 0（不猜）。
 *
 * @param block ContentBlock（至少含 type，text 块需含 text）
 * @returns 归一化片段
 */
export function contentBlockSegment(block: {
  type?: string;
  text?: string;
  name?: string;
  url?: string;
  src?: string;
  path?: string;
  filename?: string;
}): Segment {
  if (block.type === 'text' && typeof block.text === 'string') {
    return textSegment(block.text);
  }
  if (block.type === 'image' || block.type === 'image_url' || block.type === 'input_image') {
    return { kind: 'image', fixed: IMAGE_TOKEN_ESTIMATE };
  }
  if (block.type === 'audio' || block.type === 'input_audio') return { kind: 'audio', fixed: AUDIO_TOKEN_ESTIMATE };
  if (block.type === 'video') return { kind: 'video', fixed: VIDEO_TOKEN_ESTIMATE };
  const body =
    typeof block.text === 'string'
      ? block.text
      : [block.name, block.url, block.src, block.path, block.filename]
          .filter((v): v is string => typeof v === 'string')
          .join(' ');
  return textSegment(body);
}

/**
 * 估算单个 content block 的 token 数
 *
 * @param block ContentBlock（至少含 type；text 块需含 text；未知块可带指针字段）
 * @returns 估算 token 数
 */
export function estimateContentBlock(block: Parameters<typeof contentBlockSegment>[0]): number {
  return estimateSegments([contentBlockSegment(block)]);
}

/**
 * 工具调用 → tool_use 段
 *
 * `arguments` 已是字符串时直接用长度，避免二次 JSON.stringify。
 */
export function toolCallSegment(name: string | undefined, args: unknown): Segment {
  const argStr = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  return { kind: 'tool_use', nameChars: (name ?? '').length, argChars: argStr.length };
}

/**
 * 估算工具调用 JSON 的 token 数
 *
 * @param toolCalls `{ name?, arguments? }` 形态的工具调用列表
 * @returns 估算 token 数
 */
export function estimateToolCallTokens(toolCalls: Array<{ name?: string; arguments?: unknown }>): number {
  return estimateSegments(toolCalls.map((tc) => toolCallSegment(tc.name, tc.arguments)));
}

/**
 * 估算松散结构消息列表的 token 数
 *
 * 支持 string 和 ContentBlock[] 两种 content 格式，含消息结构开销。
 * 适用于无强类型 Message / LLMMessage 的调用方（knowledge grounding 等）。
 *
 * @param messages `{ content?, role? }` 形态的消息列表
 * @returns 估算 token 数
 */
export function estimateTokens(messages: Array<{ content?: string | unknown[] | null; role?: string }>): number {
  const segments: Segment[] = [];
  for (const msg of messages) {
    segments.push({ kind: 'message_overhead', count: 1 });
    if (typeof msg.content === 'string') {
      segments.push(textSegment(msg.content));
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type?: string; text?: string }>) {
        segments.push(contentBlockSegment(block));
      }
    }
  }
  return estimateSegments(segments);
}

// JSON_CHARS_PER_TOKEN 仍由本层公开导出（工具 schema 等外部调用方使用）；计数已走分类查表。
export { JSON_CHARS_PER_TOKEN };
