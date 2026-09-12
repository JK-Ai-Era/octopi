/**
 * ask_user 工具 — 请求用户输入
 *
 * 通过工厂函数接收 AskUserCallback（闭包注入），与 UI 层解耦。
 */

import type { RegisteredTool } from '../../../core/types.js';

/** askUser 回调类型 */
export type AskUserCallback = (
  question: string,
  options?: string[],
) => Promise<string>;

export function createAskUserTool(callback: AskUserCallback): RegisteredTool {
  return {
    definition: {
      name: 'ask_user',
      description: 'Ask the user a question and wait for their response. Use when you need clarification, confirmation, or a choice from the user. Optionally provide a list of suggested options.',
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
    },
    handler: async (args) => {
      const question = args.question as string;
      const options = args.options as string[] | undefined;
      const answer = await callback(question, options);
      return { answer };
    },
  };
}
