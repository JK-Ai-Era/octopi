/**
 * TaskManagerPlugin — Hook 集成层
 *
 * 编排 TaskTracker 和 TaskManager LLM，通过 agent-loop 的 hook 系统集成。
 *
 * 执行流程：
 *   before_agent_reply:
 *     1. 加载 session 的任务状态
 *     2. 调用 TaskManager LLM 做决策
 *     3. 更新 TaskTracker（interrupt, create, complete, resume, cancel）
 *     4. 缓存 taskContext
 *     5. 返回 null（不拦截，让主 LLM 处理）
 *
 *   before_prompt_build:
 *     6. 如果有缓存的 taskContext，注入到 system prompt
 *
 * 主 LLM 完全透明地看到任务上下文，自然地做出响应。
 */

import type { Plugin, PluginHooks, HookContext, Message } from '../core/types.js';
import type { LLMProvider } from '../core/types.js';
import { TaskTracker } from './tracker.js';
import { TaskManager } from './task-manager.js';
import type { TaskManagerConfig, TaskDecision } from './types.js';

export class TaskManagerPlugin implements Plugin {
  id = 'task-manager';
  name = 'Task Manager';

  private tracker: TaskTracker;
  private manager: TaskManager;
  private enabled: boolean;

  /** 缓存每个 session 的最新决策（before_agent_reply 写，before_prompt_build 读） */
  private pendingContext = new Map<string, string>();

  constructor(provider: LLMProvider, config: TaskManagerConfig) {
    this.enabled = config.enabled;
    this.tracker = new TaskTracker(config.dataDir);
    this.manager = new TaskManager(provider, config.model);
  }

  get hooks(): PluginHooks {
    return {
      before_agent_reply: this.onBeforeAgentReply.bind(this),
      before_prompt_build: this.onBeforePromptBuild.bind(this),
    };
  }

  /**
   * before_agent_reply — 任务决策
   *
   * 在主 LLM 执行前，调用 TaskManager LLM 判断：
   * - 新消息是否与当前任务相关
   * - 是否需要中断/恢复/创建/完成任务
   * - 是否需要注入任务上下文
   */
  private async onBeforeAgentReply(
    ctx: HookContext & { messages: Message[] },
  ): Promise<Message | null> {
    if (!this.enabled) return null;

    const { sessionId, messages } = ctx;

    // 确保任务状态已加载
    this.tracker.loadSession(sessionId);

    // 获取当前任务状态
    const currentTasks = this.tracker.getActiveTasks(sessionId);

    // 提取最新用户消息
    const lastUserMessage = [...messages]
      .reverse()
      .find((m) => m.role === 'user');
    const newMessage = lastUserMessage?.content ?? '';

    if (!newMessage) return null;

    // 构建最近上下文（最近 3 条消息摘要）
    const recentMessages = messages.slice(-6);
    const recentContext = recentMessages
      .map((m) => {
        const preview = m.content.slice(0, 100);
        return `[${m.role}] ${preview}${m.content.length > 100 ? '...' : ''}`;
      })
      .join('\n');

    // 调用 TaskManager LLM
    const decision = await this.manager.decide({
      sessionId,
      currentTasks,
      newMessage,
      recentContext,
    });

    console.log(
      `[TaskManager] Session ${sessionId}: ${decision.reason}`,
    );

    // 执行决策
    this.applyDecision(sessionId, decision);

    // 缓存 taskContext（给 before_prompt_build 用）
    if (decision.injectTaskContext && decision.taskContext) {
      this.pendingContext.set(sessionId, decision.taskContext);
    } else {
      this.pendingContext.delete(sessionId);
    }

    // 不拦截，让主 LLM 处理
    return null;
  }

  /**
   * before_prompt_build — 注入任务上下文
   *
   * 如果 TaskManager 决策需要注入任务上下文，
   * 通过 prependContext 注入到 system prompt 中。
   */
  private async onBeforePromptBuild(
    ctx: HookContext & { messages: Message[] },
  ): Promise<{ prependContext?: string } | null> {
    if (!this.enabled) return null;

    const taskContext = this.pendingContext.get(ctx.sessionId);
    if (!taskContext) return null;

    // 用完即删（只注入一次）
    this.pendingContext.delete(ctx.sessionId);

    return { prependContext: taskContext };
  }

  /**
   * 执行 TaskManager 的决策
   */
  private applyDecision(sessionId: string, decision: TaskDecision): void {
    // 1. 中断被打断的任务
    for (const taskId of decision.interruptedTasks) {
      this.tracker.interrupt(taskId, decision.reason);
    }

    // 2. 恢复任务
    if (decision.resumeTask) {
      this.tracker.resume(decision.resumeTask);
    }

    // 3. 完成任务
    if (decision.completesTask) {
      this.tracker.complete(decision.completesTask);
    }

    // 4. 取消任务
    if ((decision as any).cancelTask) {
      this.tracker.cancel((decision as any).cancelTask);
    }

    // 5. 新建任务
    if (decision.newTask) {
      this.tracker.create(sessionId, decision.newTask);
    }
  }

  /**
   * 获取 TaskTracker（供外部查询）
   */
  getTracker(): TaskTracker {
    return this.tracker;
  }
}
