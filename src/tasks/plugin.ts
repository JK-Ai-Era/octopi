/**
 * TaskManagerPlugin — Iteration Hook 集成层
 *
 * 编排 TaskTracker 和 TaskManager LLM，通过 agent-loop 的迭代级 hook 集成。
 *
 * 使用 definePluginEntry() API 创建 plugin。
 *
 * 执行流程：
 *   before_iteration:
 *     1. 加载 session 的任务状态
 *     2. 调用 TaskManager LLM 做决策
 *     3. 更新 TaskTracker（interrupt, create, complete, resume, cancel）
 *     4. 注入 taskContext 到本轮 system prompt
 *
 *   after_iteration:
 *     5. 可选：根据 LLM 结果更新任务状态
 *
 * 注意：这个版本使用 Octopi 独有的迭代级 hook（before_iteration/after_iteration），
 * 而非 OpenClaw 的 per-message hook（before_agent_reply/after_agent_reply）。
 * 因为 TaskManager 需要在每次 LLM 调用前评估任务状态，而非每次用户消息前。
 */

import type { Message } from '../core/types.js';
import type { LLMProvider } from '../core/types.js';
import { definePluginEntry } from '../plugins/entry.js';
import type { OctopiPluginDefinition } from '../plugins/entry.js';
import { TaskTracker } from './tracker.js';
import { TaskManager } from './task-manager.js';
import { applyDecision } from './shared.js';
import type { TaskManagerConfig } from './types.js';

/**
 * 创建 TaskManagerPlugin
 *
 * 使用迭代级 hook（before_iteration / after_iteration）。
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

  return definePluginEntry({
    id: 'task-manager',
    name: 'Task Manager',
    description: '任务编排系统 — 自动追踪和管理多任务（迭代级 hook 集成）',

    register(api) {
      if (!enabled) {
        api.logger.warn('TaskManager is disabled');
        return;
      }

      // ── before_iteration — 每次 LLM 调用前的任务决策 ──
      // 这是 Octopi 独有的迭代级 hook，不同于 OpenClaw 的 per-message hook。
      // 优势：在每次 LLM 迭代前评估任务状态，而非仅在用户消息到达时。
      api.on('before_iteration', async (event: any) => {
        const { sessionId, iteration, messages } = event;
        if (!sessionId) return null;

        // 加载 session 的任务状态
        await tracker.loadSession(sessionId);
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

        api.logger.info(
          `[iteration ${iteration}] Session ${sessionId}: ${decision.reason}`
        );

        // 执行决策
        await applyDecision(tracker, sessionId, decision);

        // 注入 taskContext 到本轮 system prompt
        if (decision.injectTaskContext && decision.taskContext) {
          return { prependContext: decision.taskContext };
        }

        return null;
      }, { priority: 10 });

      // ── after_iteration — 每次 LLM 调用 + 工具执行后 ──
      // 可选：根据 LLM 的响应更新任务状态。
      // 目前不做自动更新，由 TaskManager LLM 在下一轮 before_iteration 中判断。
      api.on('after_iteration', async (_event: any) => {
        // 未来可扩展：检测"任务完成"的 LLM 响应模式
      }, { priority: 10 });

      // ── gateway_start — 初始化 ──
      api.on('gateway_start', async () => {
        api.logger.info('TaskManager plugin initialized');
      });

      api.logger.info('TaskManager plugin registered');
    },
  });
}


