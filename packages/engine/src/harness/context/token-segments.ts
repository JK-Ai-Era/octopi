/**
 * Token 估算统一计数核心（P1-c：单实现 + 两 adapter）
 *
 * 「计数与入口形状无关」（arch/context-size-accounting.md §4.2）：
 * 入口形状（领域 `Message` / provider `LLMMessage`）只在 adapter 层归一为
 * `Segment`，本模块是**唯一计数逻辑**。同内容两入口读数一致是测试红线（差 < 1%）。
 *
 * 比率策略：**先分类、再查表**（{@link CHARS_PER_TOKEN_BY_KIND}）。
 * 取代旧 `estimateAdjustedChars` 的「nonLatin×3 膨胀」hack——那个 hack 是为
 * text(4) 比率设计的，挪到 tool_result(2) 上会让全 CJK 结果变成 2 token/字（错一倍）。
 *
 * R4 红线：估算器不得返回常数兜底；未知内容块按长度计（告警半项归 P2-a）。
 */

/** 分类查表：chars/token（单源在 token-constants，此处只做语义命名） */
export const CHARS_PER_TOKEN_BY_KIND = {
  /** 英文散文 */
  text_ascii: CHARS_PER_TOKEN,
  /** 中文等 CJK（1 token/字） */
  text_cjk: TEXT_CJK_CHARS_PER_TOKEN,
  /** 工具结果：结构化输出更密集 */
  tool_result: TOOL_RESULT_CHARS_PER_TOKEN,
  /** JSON 负载（schema / arguments） */
  json: JSON_CHARS_PER_TOKEN,
  /** 代码 / 标识符 */
  code: CODE_CHARS_PER_TOKEN,
} as const;

/**
 * 归一化内容片段。
 *
 * `message_overhead` 为实现扩展（sketch 未列）：消息结构开销（role/分隔符/边界标记）
 * 不属于内容，但必须有唯一归属处——两个 adapter 在形状归一时按消息数生成。
 */
export type Segment =
  | { kind: 'text'; chars: number; cjk: number }
  | { kind: 'tool_use'; nameChars: number; argChars: number }
  | { kind: 'tool_result'; chars: number; cjk: number; isError: boolean }
  | { kind: 'json'; chars: number }
  | { kind: 'image' | 'audio' | 'video'; fixed: number }
  | { kind: 'message_overhead'; count: number };

/** 消息结构开销（role + 分隔符 + 边界标记），单位 token（常量单源在 token-constants） */
export { MESSAGE_OVERHEAD_TOKENS } from './token-constants.js';
import {
  MESSAGE_OVERHEAD_TOKENS,
  CHARS_PER_TOKEN,
  TOOL_RESULT_CHARS_PER_TOKEN,
  JSON_CHARS_PER_TOKEN,
  TEXT_CJK_CHARS_PER_TOKEN,
  CODE_CHARS_PER_TOKEN,
} from './token-constants.js';

// ── CJK 分类 ──
// 非拉丁字符检测，覆盖完整东亚字符范围（BMP）
const NON_LATIN_RE =
  /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\uFF01-\uFF60\uFFE0-\uFFE6]/gu;

// CJK 扩展 B–H 的 surrogate pairs（U+20000–U+323AF）：2 个 UTF-16 单元 = 1 个字符
const CJK_SURROGATE_HIGH_RE = /[\uD840-\uD888][\uDC00-\uDFFF]/g;

/**
 * 字符分类：统计文本的码点数与其中的 CJK 数。
 *
 * 旧 `estimateAdjustedChars` 把 CJK 扩展 B 计成 ASCII（正则不匹配 surrogate），
 * 此处并入 CJK（1 token/字）。其余非 BMP 码点（emoji 等）维持旧口径按 2 单元计，
 * 不在本批静默调参。
 *
 * @param text 原始文本
 * @returns chars=码点数；cjk=CJK 码点数（含扩展 B）
 */
export function classifyChars(text: string): { chars: number; cjk: number } {
  if (text.length === 0) return { chars: 0, cjk: 0 };
  const surrogatePairs = (text.match(CJK_SURROGATE_HIGH_RE) ?? []).length;
  const chars = text.length - surrogatePairs;
  const cjk = (text.match(NON_LATIN_RE) ?? []).length + surrogatePairs;
  return { chars, cjk };
}

/** 文本 → text 段（adapter 便捷入口） */
export function textSegment(text: string): Segment {
  const { chars, cjk } = classifyChars(text);
  return { kind: 'text', chars, cjk };
}

/**
 * 分段求和（不取整）：两入口共用的浮点累加，供调用方在**总量**上统一取整——
 * 逐消息取整会让读数随消息切分形态漂移（评审 #3）。
 *
 * @param segments 归一化内容片段
 * @returns 估算 token 数（浮点）
 */
export function sumSegments(segments: Segment[]): number {
  let total = 0;
  for (const seg of segments) {
    switch (seg.kind) {
      case 'text':
        total += seg.cjk / CHARS_PER_TOKEN_BY_KIND.text_cjk + (seg.chars - seg.cjk) / CHARS_PER_TOKEN_BY_KIND.text_ascii;
        break;
      case 'tool_use':
        total += seg.nameChars / CHARS_PER_TOKEN_BY_KIND.code + seg.argChars / CHARS_PER_TOKEN_BY_KIND.json;
        break;
      case 'tool_result':
        // 分类计数：CJK 段按 1 token/字，结构化 ASCII 段按 TOOL_RESULT_CHARS_PER_TOKEN（1.7，2026-11-08 L1 调表）。
        // isError 当前与正常结果同权（属性保留，调参留待有实测支撑时）。
        total += seg.cjk / CHARS_PER_TOKEN_BY_KIND.text_cjk + (seg.chars - seg.cjk) / CHARS_PER_TOKEN_BY_KIND.tool_result;
        break;
      case 'json':
        total += seg.chars / CHARS_PER_TOKEN_BY_KIND.json;
        break;
      case 'image':
      case 'audio':
      case 'video':
        total += seg.fixed;
        break;
      case 'message_overhead':
        total += seg.count * MESSAGE_OVERHEAD_TOKENS;
        break;
    }
  }
  return total;
}

/**
 * 唯一计数逻辑：Segment 列表 → token 估算（总量一次取整）。
 *
 * @param segments 归一化内容片段
 * @returns 估算 token 数
 */
export function estimateSegments(segments: Segment[]): number {
  return Math.ceil(sumSegments(segments));
}
