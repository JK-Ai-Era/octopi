/**
 * TaskManagerPlugin — Hook 集成层
 *
 * 编排 TaskTracker 和 TaskManager LLM，通过 agent-loop 的 hook 系统集成。
 *
 * 使用新的 definePluginEntry() API 创建 plugin。
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
 */

import type { Message } from '../core/types.js';
import type { LLMProvider } from '../core/types.js';
import { definePluginEntry } from '../plugins/entry.js';
import type { OctopiPluginDefinition } from '../plugins/entry.js';
import { TaskTracker } from './tracker.js';
import { TaskManager } from './task-manager.js';
import type { TaskManagerConfig, TaskDecision } from './types.js';

/**
 * 创建 TaskManagerPlugin
 *
 * 使用新的 definePluginEntry() API。
 *
 * @param provider - LLM Provider
 * @param config - TaskManager 配置
 * @returns Plugin 定义
 */
export function createTaskManagerPlugin(
  provider: LLMProvider,
  config: TaskManagerConfig,
): OctopiPluginDefinition {
  const tracker = new TaskTracker(config.dataDir);
  const manager = new TaskManager(provider, config.model);
  const enabled = config.enabled;

  /** 缓存每个 session 的最新决策（before_agent_reply 写，before_prompt_build 读） */
  const pendingContext = new Map<string, string>();

  /**
   * 执行 TaskManager 的决策
   */
  function applyDecision(sessionId: string, decision: TaskDecision): void {
    for (const taskId of decision.interruptedTasks) {
      tracker.interrupt(taskId, decision.reason);
    }
    if (decision.resumeTask) {
      tracker.resume(decision.resumeTask);
    }
    if (decision.completesTask) {
      tracker.complete(decision.completesTask);
    }
    if ((decision as any).cancelTask) {
      tracker.cancel((decision as any).cancelTask);
    }
    if (decision.newTask) {
      tracker.create(sessionId, decision.newTask);
    }
  }

  return definePluginEntry({
    id: 'task-manager',
    name: 'Task Manager',
    description: '任务编排系统 — 自动追踪和管理多任务',

    register(api) {
      if (!enabled) {
        api.logger.warn('TaskManager is disabled');
        return;
      }

      // before_agent_reply — 任务决策（优先级 10，在默认 0 之前）
      api.on('before_agent_reply', async (event: any) => {
        const { messages, sessionId } = event;
        if (!sessionId) return null;

        // 确保任务状态已加载
        tracker.loadSession(sessionId);

        // 获取当前任务状态
        const currentTasks = tracker.getActiveTasks(sessionId);

        // 提取最新用户消息
        const lastUserMessage = [...messages]
          .reverse()
          .find((m: Message) => m.role === 'user');
        const newMessage = lastUserMessage?.content ?? '';

        if (!newMessage) return null;

        // 构建最近上下文
        const recentMessages = messages.slice(-6);
        const recentContext = recentMessages
          .map((m: Message) => {
            const preview = m.content.slice(0, 100);
            return `[${m.role}] ${preview}${m.content.length > 100 ? '...' : ''}`;
          })
          .join('\n');

        // 调用 TaskManager LLM
        const decision = await manager.decide({
          sessionId,
          currentTasks,
          newMessage,
          recentContext,
        });

        api.logger.info(`Session ${sessionId}: ${decision.reason}`);

        // 执行决策
        applyDecision(sessionId, decision);

        // 缓存 taskContext
        if (decision.injectTaskContext && decision.taskContext) {
          pendingContext.set(sessionId, decision.taskContext);
        } else {
          pendingContext.delete(sessionId);
        }

        // 不拦截，让主 LLM 处理
        return null;
      }, { priority: 10 });

      // before_prompt_build — 注入任务上下文
      api.on('before_prompt_build', async (event: any) => {
        const { sessionId } = event;
        if (!sessionId) return null;

        const taskContext = pendingContext.get(sessionId);
        if (!taskContext) return null;

        // 用完即删（只注入一次）
        pendingContext.delete(sessionId);

        return { prependContext: taskContext };
      }, { priority: 10 });

      // gateway_start — 初始化
      api.on('gateway_start', async () => {
        api.logger.info('TaskManager plugin initialized');
      });

      api.logger.info('TaskManager plugin registered');
    },
  });
}

/**
 * @deprecated 使用 createTaskManagerPlugin() 代替
 *
 * 旧版兼容类，实现 Plugin 接口。
 * 新代码请使用 createTaskManagerPlugin()。
 */
export class TaskManagerPlugin {
  id = 'task-manager';
  name = 'Task Manager';

  private tracker: TaskTracker;
  private manager: TaskManager;
  private enabled: boolean;
  private pendingContext = new Map<string, string>();

  constructor(provider: LLMProvider, config: TaskManagerConfig) {
    this.enabled = config.enabled;
    this.tracker = new TaskTracker(config.dataDir);
    this.manager = new TaskManager(provider, config.model);
  }

  get hooks() {
    return {
      before_agent_reply: this.onBeforeAgentReply.bind(this),
      before_prompt_build: this.onBeforePromptBuild.bind(this),
    };
  }

  private async onBeforeAgentReply(
    ctx: any,
  ): Promise<Message | null> {
    if (!this.enabled) return null;
    const { sessionId, messages } = ctx;
    this.tracker.loadSession(sessionId);
    const currentTasks = this.tracker.getActiveTasks(sessionId);
    const lastUserMessage = [...messages].reverse().find((m: Message) => m.role === 'user');
    const newMessage = lastUserMessage?.content ?? '';
    if (!newMessage) return null;
    const recentMessages = messages.slice(-6);
    const recentContext = recentMessages.map((m: Message) => {
      const preview = m.content.slice(0, 100);
      return `[${m.role}] ${preview}${m.content.length > 100 ? '...' : ''}`;
    }).join('\n');
    const decision = await this.manager.decide({ sessionId, currentTasks, newMessage, recentContext });
    console.log(`[TaskManager] Session ${sessionId}: ${decision.reason}`);
    this.applyDecision(sessionId, decision);
    if (decision.injectTaskContext && decision.taskContext) {
      this.pendingContext.set(sessionId, decision.taskContext);
    } else {
      this.pendingContext.delete(sessionId);
    }
    return null;
  }

  private async onBeforePromptBuild(ctx: any): Promise<{ prependContext?: string } | null> {
    if (!this.enabled) return null;
    const taskContext = this.pendingContext.get(ctx.sessionId);
    if (!taskContext) return null;
    this.pendingContext.delete(ctx.sessionId);
    return { prependContext: taskContext };
  }

  private applyDecision(sessionId: string, decision: TaskDecision): void {
    for (const taskId of decision.interruptedTasks) this.tracker.interrupt(taskId, decision.reason);
    if (decision.resumeTask) this.tracker.resume(decision.resumeTask);
    if (decision.completesTask) this.tracker.complete(decision.completesTask);
    if ((decision as any).cancelTask) this.tracker.cancel((decision as any).cancelTask);
    if (decision.newTask) this.tracker.create(sessionId, decision.newTask);
  }

  getTracker(): TaskTracker {
    return this.tracker;
  }
}
