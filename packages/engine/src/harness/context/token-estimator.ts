/**
 * HeuristicTokenEstimator — 启发式 Token 估算器
 *
 * 实现本域 `TokenEstimator` 契约（`./types.ts`）。**计数逻辑唯一**在
 * `token-segments.ts`（P1-c「单实现 + 两 adapter」）；本文件是两个形状 adapter：
 * - {@link fromDomainMessages}：领域 `Message[]`（toolCalls / toolResults 字段）
 * - {@link fromLlmMessages}：provider `LLMMessage[]`（tool_calls / tool_use /
 *   tool_result 块 / role:'tool' 消息）
 *
 * 同内容两入口读数一致是测试红线（差 < 1%）。两处旧口径缺陷已随统一修正：
 * 1. LLM 口径把 tool_use / tool_result 块落「常数 10」兜底（R4 违约）→ 分类计数；
 * 2. 领域口径的 CJK 膨胀 hack 挪到 2 比率上高倍（全 CJK 工具结果 2 token/字）→ 分类查表。
 *
 * 三层策略：
 * 1. 优先使用 LLM 返回的实际 token 数（usage reported prompt）- 外部回写
 * 2. 次选：专用 tokenizer（如 tiktoken）- 未来扩展
 * 3. 兜底：启发式估算，按内容类型使用不同比率
 */

import type { Message } from '@octopi-agent/core/types.js';
import type { TokenEstimator } from './types.js';
import type { LLMMessage, LLMToolDefinition } from '@octopi-agent/core/interfaces/model-provider.js';
import { estimateTextTokens, contentBlockSegment, toolCallSegment } from './token-estimate-fns.js';
import { estimateSegments, sumSegments, textSegment, classifyChars, type Segment } from './token-segments.js';
import { toolResultBody } from './tool-result-body.js';

// Re-export for callers that only need text estimation
export { estimateTextTokens } from './token-estimate-fns.js';

/**
 * 消息级 token 估算缓存（模块级：estimator 实例众多，实例级缓存无命中率）。
 *
 * 安全前提：消息内容写入后不可变（估算只读 content/toolCalls/toolResults）。
 * 估算对同一消息是纯函数，跨实例结果必须一致。
 */
const messageTokensCache = new WeakMap<Message, number>();

/** 领域消息 → Segment[]（adapter：只做形状归一；空串 content 不产生段，保两入口形状对称） */
function fromDomainMessage(message: Message): Segment[] {
  // wire 对齐（评审 #4）：convertMessage 把带 N 条 toolResults 的消息发成 N 条
  // role:'tool' 消息（各带一条开销）；其余消息 1 条开销。
  const overhead = message.toolResults?.length ? message.toolResults.length : 1;
  const segments: Segment[] = [{ kind: 'message_overhead', count: overhead }];
  if (typeof message.content === 'string') {
    if (message.content.length > 0) segments.push(textSegment(message.content));
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      segments.push(contentBlockSegment(block as { type?: string; text?: string }));
    }
  }
  if (message.toolCalls) {
    for (const tc of message.toolCalls) {
      segments.push(toolCallSegment(tc.name, tc.arguments));
    }
  }
  if (message.toolResults) {
    for (const tr of message.toolResults) {
      const body = toolResultBody(tr);
      const { chars, cjk } = classifyChars(body);
      segments.push({ kind: 'tool_result', chars, cjk, isError: tr.error !== undefined });
    }
  }
  return segments;
}

/** 领域消息列表 → Segment[]（adapter 公开入口） */
export function fromDomainMessages(messages: Message[]): Segment[] {
  const segments: Segment[] = [];
  for (const message of messages) segments.push(...fromDomainMessage(message));
  return segments;
}

/** provider 内容块 → Segment（tool_use / tool_result 块专用归一） */
function llmContentBlockSegment(block: Record<string, unknown>): Segment {
  const type = typeof block.type === 'string' ? block.type : undefined;
  if (type === 'tool_use') {
    return toolCallSegment(
      typeof block.name === 'string' ? block.name : undefined,
      block.input ?? block.arguments ?? {},
    );
  }
  if (type === 'tool_result') {
    const raw = block.content ?? block.text ?? '';
    const body = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const { chars, cjk } = classifyChars(body);
    return { kind: 'tool_result', chars, cjk, isError: block.is_error === true };
  }
  return contentBlockSegment(block as { type?: string; text?: string });
}

/** provider LLM 消息 → Segment[]（adapter 公开入口） */
export function fromLlmMessages(messages: LLMMessage[]): Segment[] {
  const segments: Segment[] = [];
  for (const msg of messages) {
    segments.push({ kind: 'message_overhead', count: 1 });
    // OpenAI 风格 role:'tool' 消息即工具结果（旧口径按文本比率低计，P1-c 修正）
    if (msg.role === 'tool') {
      const body = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
      const { chars, cjk } = classifyChars(body);
      segments.push({ kind: 'tool_result', chars, cjk, isError: false });
      continue;
    }
    if (typeof msg.content === 'string') {
      if (msg.content.length > 0) segments.push(textSegment(msg.content));
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        segments.push(llmContentBlockSegment(block));
      }
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        segments.push(toolCallSegment(tc.function?.name, tc.function?.arguments ?? ''));
      }
    }
  }
  return segments;
}

/**
 * 估算 LLM 消息列表的 token 数
 *
 * 适配 provider 侧 `LLMMessage`（OpenAI 风格 `tool_calls` / Anthropic 风格
 * `tool_use` / `tool_result` 内容块 / `role:'tool'` 消息）。
 *
 * @param messages LLM 消息列表
 * @returns 估算 token 数
 */
export function estimateLLMMessages(messages: LLMMessage[]): number {
  return estimateSegments(fromLlmMessages(messages));
}

/** 启发式 Token 估算器实现 */
export class HeuristicTokenEstimator implements TokenEstimator {
  /**
   * 估算单条消息的 token 数
   *
   * 支持 string 和 ContentBlock[] 两种 content 格式。
   * 包含消息结构开销（role、分隔符等）。
   *
   * @param message 领域消息
   * @returns 估算 token 数
   */
  estimateMessage(message: Message): number {
    return Math.ceil(this.rawEstimateMessage(message));
  }

  /**
   * 估算多条消息的总 token 数
   *
   * 总量一次取整（评审 #3）：逐消息取整会让读数随消息切分形态漂移。
   *
   * @param messages 领域消息列表
   * @returns 估算 token 数
   */
  estimateMessages(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.rawEstimateMessage(msg);
    }
    return Math.ceil(total);
  }

  /** 单条消息的浮点估算（WeakMap 缓存存未取整值，取整只发生在对外读数上） */
  private rawEstimateMessage(message: Message): number {
    const cached = messageTokensCache.get(message);
    if (cached !== undefined) return cached;

    const tokens = sumSegments(fromDomainMessage(message));
    messageTokensCache.set(message, tokens);
    return tokens;
  }

  /**
   * 估算文本的 token 数
   *
   * @param text 原始文本
   * @returns 估算 token 数
   */
  estimateText(text: string): number {
    return estimateTextTokens(text);
  }

  /**
   * 估算工具定义的 token 数
   *
   * 工具定义包含：名称、描述、参数 schema。
   * JSON schema 结构符号多，token 密度高。
   *
   * @param tools 工具定义列表
   * @returns 估算 token 数
   */
  estimateTools(tools: LLMToolDefinition[]): number {
    const segments: Segment[] = [];
    for (const tool of tools) {
      const fn = tool.function;
      segments.push(textSegment(fn.name));
      segments.push(textSegment(fn.description));
      segments.push({ kind: 'json', chars: JSON.stringify(fn.parameters ?? {}).length });
    }
    return estimateSegments(segments);
  }
}
