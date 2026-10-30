/**
 * LLM 输出完整性保障 —— maxTokens 只是发给 provider 的生成配额，不是业务截断边界。
 *
 * 语义（2026-10-30 拍板）：`finish=length`（配额截断）或 parse 失败的输出都**不得**当业务
 * 结果收下（禁止静默半截结果）；先放大配额重试一次，仍失败则返回显式失败原因，由调用方
 * 决定如何上报。业务完整性优先于调用成本。
 *
 * @module harness/collaboration/autonomous-subsystem/think/completion-guard
 */

import type { LLMMessage, LLMResponse } from '@octopi-agent/core/interfaces/model-provider.js';
import type { SubsystemLLMPort } from './llm-port.js';

/** 重试放大配额的硬上限（防 provider 400；超过此值仍截断按显式失败处理） */
const RETRY_MAX_TOKENS_CAP = 32768;

/** 完整性调用的失败原因 */
export type CompletionGuardFailure = 'llm_error' | 'llm_empty' | 'truncated_output' | 'parse_failed';

/** 完整性调用结果：成功带解析后的业务结构，失败带显式原因 */
export type CompletionGuardResult<T> =
  | { ok: true; parsed: T; raw: string }
  | { ok: false; reason: CompletionGuardFailure; message: string };

export interface CompletionGuardRequest {
  /** 覆盖认知 prompt；默认使用 port 绑定的 SUBSYSTEM.md 正文 */
  systemPrompt?: string;
  /** 对话消息（不含 system） */
  messages: LLMMessage[];
  /** 生成配额（LLM 传参）；截断时重试放大 2 倍，硬上限 {@link RETRY_MAX_TOKENS_CAP} */
  maxTokens: number;
}

/**
 * 带输出完整性保障的单轮 LLM 调用：截断或解析失败时放大配额重试一次。
 *
 * @param llmPort - subsystem LLM 端口
 * @param req - systemPrompt / messages / maxTokens（生成配额，非业务截断）
 * @param parse - 从 LLM 文本解析业务结构；失败返回 null
 * @returns 成功返回 parsed；失败返回 llm_error / truncated_output / parse_failed（至多 2 次 LLM 调用）
 */
export async function chatForCompleteOutput<T>(
  llmPort: SubsystemLLMPort,
  req: CompletionGuardRequest,
  parse: (text: string) => T | null,
): Promise<CompletionGuardResult<T>> {
  let lastFailure: CompletionGuardFailure = 'parse_failed';
  let lastMessage = 'parse_failed';

  for (let attempt = 0; attempt < 2; attempt++) {
    const maxTokens =
      attempt === 0 ? req.maxTokens : Math.min(req.maxTokens * 2, RETRY_MAX_TOKENS_CAP);

    let res: LLMResponse;
    try {
      res = await llmPort.chat({
        systemPrompt: req.systemPrompt,
        messages: req.messages,
        // 温度留空：由模型配置（ModelInfo.temperature）或服务端默认决定
        maxTokens,
      });
    } catch (err) {
      return { ok: false, reason: 'llm_error', message: err instanceof Error ? err.message : String(err) };
    }
    if (res.finishReason === 'error') {
      return { ok: false, reason: 'llm_error', message: res.content || 'llm chat error' };
    }
    // 配额截断：半截输出不是业务结果，放大配额重试
    if (res.finishReason === 'length') {
      lastFailure = 'truncated_output';
      lastMessage = `truncated_output: completion hit maxTokens=${maxTokens}`;
      continue;
    }

    const raw = res.content ?? '';
    if (!raw.trim()) {
      lastFailure = 'llm_empty';
      lastMessage = 'llm_empty: empty completion content';
      continue;
    }
    const parsed = parse(raw);
    if (parsed !== null) return { ok: true, parsed, raw };
    lastFailure = 'parse_failed';
    lastMessage = 'parse_failed';
  }

  return { ok: false, reason: lastFailure, message: lastMessage };
}
