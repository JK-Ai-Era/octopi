/**
 * DefaultTaskDecisionProvider — 默认任务决策提供者
 *
 * Harness 层实现。在用户消息到达时调用轻量 LLM 判断任务状态，
 * 将结果注入到 runConfig.injectedContext。
 *
 * 调用时机：SessionAwareRunner.handle() 中，用户消息到达后、engine.run() 前，只调用一次。
 * 工具调用循环中不会重复调用。
 *
 * 核心流程：
 * 1. 从 Session 加载当前活跃任务（TaskTracker）
 * 2. 提取最新用户消息
 * 3. 调用轻量 LLM 做决策（TaskManager）
 * 4. 根据决策更新任务状态
 * 5. 返回 taskContext 字符串，由 SessionAwareRunner 注入到 runConfig
 */

import type { Message } from '../../core/types.js';
import { getTextContent } from '../../core/types.js';
import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type { TaskDecisionProvider, TaskDecisionResult } from '../runner.js';
import { TaskTracker } from './tracker.js';
import { TaskManager } from './manager.js';
import { applyDecision } from './shared.js';

/** DefaultTaskDecisionProvider 配置 */
export interface DefaultTaskDecisionProviderConfig {
  /** 任务数据目录 */
  dataDir?: string;
  /** TaskManager 使用的 ModelProvider */
  provider: ModelProvider;
  /** TaskManager 使用的模型 */
  model: string;
}

/**
 * DefaultTaskDecisionProvider
 *
 * 在用户消息到达时调用 LLM 判断任务状态，返回要注入的上下文。
 */
export class DefaultTaskDecisionProvider implements TaskDecisionProvider {
  private tracker: TaskTracker;
  private manager: TaskManager;

  constructor(config: DefaultTaskDecisionProviderConfig) {
    this.tracker = new TaskTracker(config.dataDir);
    this.manager = new TaskManager(config.provider, config.model);
  }

  async decide(params: {
    sessionId: string;
    messages: Message[];
  }): Promise<TaskDecisionResult> {
    const { sessionId, messages } = params;

    // 1. 加载任务状态
    await this.tracker.loadSession(sessionId);
    const activeTasks = this.tracker.getActiveTasks(sessionId);

    // 2. 提取最新用户消息
    const lastUserMessage = [...messages]
      .reverse()
      .find(m => m.role === 'user');
    const newMessage = lastUserMessage ? getTextContent(lastUserMessage.content) : '';

    if (!newMessage) {
      return { taskContext: undefined, reason: 'No user message' };
    }

    // 3. 构建最近上下文
    const recentMessages = messages.slice(-6);
    const recentContext = recentMessages
      .map(m => {
        const text = getTextContent(m.content);
        const preview = text.slice(0, 100);
        return `[${m.role}] ${preview}${text.length > 100 ? '...' : ''}`;
      })
      .join('\n');

    // 4. 调用 TaskManager LLM 做决策
    const decision = await this.manager.decide({
      sessionId,
      currentTasks: activeTasks,
      newMessage,
      recentContext,
    });

    // 5. 执行决策（更新任务状态）
    await applyDecision(this.tracker, sessionId, decision);

    // 6. 返回任务上下文
    if (decision.injectTaskContext && decision.taskContext) {
      return {
        taskContext: '<task_context>\n' + decision.taskContext + '\n</task_context>',
        reason: decision.reason,
      };
    }

    return { taskContext: undefined, reason: decision.reason };
  }
}
