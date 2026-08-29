/**
 * TaskDecisionProvider — 任务决策接口
 *
 * 在用户消息到达时调用，判断任务状态并注入上下文。
 * 定义在 Core 层（v0.8.0），由 harness/tasks/ 实现，runner.ts 消费。
 */

import type { Message } from '../types/messages.js';

/** 任务决策提供者接口 */
export interface TaskDecisionProvider {
  decide(params: {
    sessionId: string;
    messages: Message[];
  }): Promise<TaskDecisionResult>;
}

/** 任务决策结果 */
export interface TaskDecisionResult {
  /** 注入到 systemPrompt 的任务上下文 */
  taskContext?: string;
  /** 决策理由（用于日志/可观测性） */
  reason?: string;
}
