/**
 * TaskStage — ContextPipeline 的任务上下文阶段
 *
 * 在每次 LLM 调用前，通过 TaskTracker + TaskManager 评估任务状态，
 * 将任务上下文注入到 system prompt。
 *
 * 这是 Task System 在新架构中的集成方式。
 * 不是回调槽，是管道阶段——因为 Task 的本质是"上下文增强"。
 *
 * 执行流程：
 * 1. 从 StageContext 获取 sessionId
 * 2. await tracker.loadSession(sessionId) — 从 JSONL 恢复任务状态
 * 3. 构建 TaskDecisionInput（当前任务 + 最新消息 + 最近上下文）
 * 4. await manager.decide(input) — 调用轻量 LLM 做决策
 * 5. await applyDecision(tracker, ...) — 更新任务状态
 * 6. 如果需要注入 → ctx.systemPrompt += taskContext
 */

import type { Message } from '../../../core/types.js';
import { getTextContent } from '../../../core/types.js';
import type { ContextStage, StageContext } from '../pipeline.js';
import type { ModelProvider } from '../../../core/interfaces/model-provider.js';
import { TaskTracker } from '../../tasks/tracker.js';
import { TaskManager } from '../../tasks/manager.js';
import { applyDecision } from '../../tasks/shared.js';

/** TaskStage 配置 */
export interface TaskStageConfig {
  /** 任务数据目录 */
  dataDir?: string;
  /** TaskManager 使用的 ModelProvider */
  provider: ModelProvider;
  /** TaskManager 使用的模型 */
  model: string;
}

/**
 * TaskStage — 注入任务上下文
 */
export class TaskStage implements ContextStage {
  readonly name = 'task';

  private tracker: TaskTracker;
  private manager: TaskManager;

  constructor(config: TaskStageConfig) {
    this.tracker = new TaskTracker(config.dataDir);
    this.manager = new TaskManager(config.provider, config.model);
  }

  async process(ctx: StageContext): Promise<StageContext> {
    // 1. 获取 sessionId
    const sessionId = ctx.extra?.sessionId as string | undefined;
    if (!sessionId) {
      // 没有 sessionId，跳过任务管理
      return ctx;
    }

    // 2. 加载任务状态
    await this.tracker.loadSession(sessionId);
    const activeTasks = this.tracker.getActiveTasks(sessionId);

    // 3. 提取最新用户消息
    const lastUserMessage = [...ctx.messages]
      .reverse()
      .find((m: Message) => m.role === 'user');
    const newMessage = lastUserMessage ? getTextContent(lastUserMessage.content) : '';

    if (!newMessage) {
      return ctx;
    }

    // 4. 构建最近上下文
    const recentMessages = ctx.messages.slice(-6);
    const recentContext = recentMessages
      .map((m: Message) => {
        const text = getTextContent(m.content);
        const preview = text.slice(0, 100);
        return `[${m.role}] ${preview}${text.length > 100 ? '...' : ''}`;
      })
      .join('\n');

    // 5. 调用 TaskManager LLM 做决策
    const decision = await this.manager.decide({
      sessionId,
      currentTasks: activeTasks,
      newMessage,
      recentContext,
    });

    // 6. 执行决策（更新任务状态）
    await applyDecision(this.tracker, sessionId, decision);

    // 7. 注入任务上下文到 system prompt
    if (decision.injectTaskContext && decision.taskContext) {
      ctx.systemPrompt = ctx.systemPrompt + '\n\n<task_context>\n' + decision.taskContext + '\n</task_context>';
    }

    return ctx;
  }
}
