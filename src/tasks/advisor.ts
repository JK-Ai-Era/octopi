/**
 * TaskManagerAdvisor — TaskManager 的 LoopAdvisor 实现
 *
 * @deprecated 使用 TaskManagerPlugin（迭代级 hook 集成）替代。
 * 新版本使用 `before_iteration`/`after_iteration` hook，
 * 比 Advisor 的 per-message 模式更适合任务管理场景。
 *
 * 迁移指南：
 *   - 旧：createTaskManagerAdvisor(tracker, manager) → 传入 advisors 数组
 *   - 新：createTaskManagerPlugin(provider, config) → 通过 PluginManager 自动注册
 *
 * 保留此文件用于向后兼容，新代码请使用 plugin.ts。
 */

import type {
  AdvisorContext,
  LoopAdvisor,
  Message,
  MetaDecision,
  TurnResult,
} from '../core/types.js';
import type { TaskTracker } from './tracker.js';
import type { TaskManager } from './task-manager.js';
import type { TaskDecision } from './types.js';

/**
 * 创建 TaskManagerAdvisor
 *
 * @deprecated 使用 createTaskManagerPlugin() 替代。
 *
 * @param tracker - TaskTracker 实例
 * @param manager - TaskManager LLM 决策器
 * @returns LoopAdvisor 实现
 */
export function createTaskManagerAdvisor(
  tracker: TaskTracker,
  manager: TaskManager,
): LoopAdvisor {
  /** 缓存每个 session 的最新决策 */
  const pendingContext = new Map<string, string>();

  /**
   * 执行 TaskManager 的决策（更新任务状态）
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

  /**
   * 提取最近对话上下文
   */
  function buildRecentContext(messages: Message[]): string {
    const recent = messages.slice(-6);
    return recent
      .map((m) => {
        const preview = m.content.slice(0, 100);
        return `[${m.role}] ${preview}${m.content.length > 100 ? '...' : ''}`;
      })
      .join('\n');
  }

  /**
   * 提取最新的用户消息
   */
  function getLastUserMessage(messages: Message[]): Message | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i];
    }
    return undefined;
  }

  return {
    name: 'task-manager',
    priority: 10,

    async beforeTurn(ctx: AdvisorContext): Promise<MetaDecision | null> {
      // 确保任务状态已加载
      tracker.loadSession(ctx.sessionId);

      // 获取当前任务状态
      const currentTasks = tracker.getActiveTasks(ctx.sessionId);

      // 提取最新用户消息
      const lastUserMsg = getLastUserMessage(ctx.messages);
      if (!lastUserMsg) return null;

      // 调用 TaskManager LLM
      const decision = await manager.decide({
        sessionId: ctx.sessionId,
        currentTasks,
        newMessage: lastUserMsg.content,
        recentContext: buildRecentContext(ctx.messages),
      });

      // 执行任务状态变更
      applyDecision(ctx.sessionId, decision);

      // 构建 MetaDecision
      const meta: MetaDecision = {};

      if (decision.injectTaskContext && decision.taskContext) {
        meta.taskContext = decision.taskContext;
        pendingContext.set(ctx.sessionId, decision.taskContext);
      }

      return meta.taskContext ? meta : null;
    },

    async afterTurn(_ctx: AdvisorContext, _result: TurnResult): Promise<void> {
      // 可选：根据 turn 结果更新任务状态
      // 目前不做自动更新，由 TaskManager LLM 在下一轮 beforeTurn 中判断
    },

    async onSteering(messages: Message[]): Promise<MetaDecision | null> {
      // Steering 消息也经过 TaskManager 处理
      // 可能触发任务中断/切换
      // 注意：这里没有 sessionId，需要从 messages 的 metadata 中获取
      // 如果获取不到，跳过处理
      return null;
    },

    async onLoopEnd(ctx: AdvisorContext): Promise<void> {
      // 清理 pending context
      pendingContext.delete(ctx.sessionId);
    },
  };
}
