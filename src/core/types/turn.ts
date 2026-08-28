/**
 * Turn（轮次）类型
 */

import type { Message } from './messages.js';

/** Token 使用量 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Turn — 一次完整的 Agent 调用 */
export interface Turn {
  id: string;
  input: Message[];
  output: Message;
  usage?: TokenUsage;
  durationMs: number;
  model: string;
  timestamp: number;
}
