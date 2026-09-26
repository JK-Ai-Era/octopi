/**
 * ask_user 工具 — 请求用户输入
 *
 * 通过工厂函数接收 AskUserCallback（闭包注入），与 UI 层解耦。
 * 回调持有「等回答」的 Promise；Gateway/UI 提供答案后工具才返回。
 *
 * 超时在此自强制（definition.timeoutMs 仅作声明，工具总线不代为执行）。
 */

import type { RegisteredTool } from '../../../core/types.js';

/** askUser 回调上下文（绑定到具体会话） */
export interface AskUserContext {
  sessionId: string;
  agentId: string;
}

/**
 * askUser 回调类型
 *
 * @param question - 向用户提出的问题
 * @param options - 可选的候选答案
 * @param context - 发起提问的会话
 * @returns 用户的回答文本；会话取消时返回 `ASK_USER_CANCELLED` 哨兵
 */
export type AskUserCallback = (
  question: string,
  options: string[] | undefined,
  context: AskUserContext,
) => Promise<string>;

/** Gateway cancel 哨兵（与 gateway.ASK_USER_CANCELLED 同值，避免 harness→integration 依赖） */
export const ASK_USER_CANCELLED = '__ask_user_cancelled__';

/** 默认等待用户回答的上限（与 definition.timeoutMs 对齐） */
const DEFAULT_ASK_TIMEOUT_MS = 300_000;

/**
 * 创建 ask_user 工具
 *
 * @param callback - 等待用户回答的回调（通常由 Gateway 挂 pending question）
 * @param options.timeoutMs - 等待上限；超时返回错误而不是悬挂
 */
export function createAskUserTool(
  callback: AskUserCallback,
  options?: { timeoutMs?: number },
): RegisteredTool {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  return {
    definition: {
      name: 'ask_user',
      description:
        'Ask the user a question and wait for their response. Use when you need clarification, confirmation, or a choice from the user. Optionally provide a list of suggested options. Do not use for things you can look up yourself.',
      parameters: {
        question: {
          type: 'string',
          description: 'The question to ask the user',
          required: true,
        },
        options: {
          type: 'array',
          description: 'Optional list of suggested answer options',
          items: { type: 'string', description: 'An option' },
        },
      },
      timeoutMs,
    },
    handler: async (args, context) => {
      const question = String(args.question ?? '').trim();
      if (!question) {
        return { answer: null, error: 'question is required' };
      }
      const options = Array.isArray(args.options)
        ? (args.options as unknown[]).map((o) => String(o))
        : undefined;

      const ctx: AskUserContext = {
        sessionId: context?.sessionId ?? 'unknown',
        agentId: context?.agentId ?? 'unknown',
      };

      // 会话已中止时不要把问题挂进 UI
      if (context?.abortSignal?.aborted) {
        return { answer: null, error: 'aborted before asking user' };
      }

      const abortSignal = context?.abortSignal;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const answer = await new Promise<string>((resolve, reject) => {
        const cleanup = () => {
          if (timer !== undefined) clearTimeout(timer);
          abortSignal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          cleanup();
          reject(new Error('ask_user aborted'));
        };

        if (abortSignal) {
          abortSignal.addEventListener('abort', onAbort, { once: true });
          if (abortSignal.aborted) {
            onAbort();
            return;
          }
        }

        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`ask_user timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        callback(question, options, ctx).then(
          (value) => {
            cleanup();
            resolve(value);
          },
          (err) => {
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });

      if (answer === ASK_USER_CANCELLED) {
        return { answer: null, error: 'aborted while waiting for user' };
      }

      return { answer };
    },
  };
}
