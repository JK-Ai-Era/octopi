/**
 * TaskManager — 轻量 LLM 决策器（新架构版本）
 *
 * 与旧版本的差异：
 * - 使用 ModelProvider 接口（新架构）代替 LLMProvider（旧架构）
 * - 消息格式使用 LLMMessage（新架构）
 */

import type { ModelProvider, LLMRequest } from '../../core/interfaces/model-provider.js';
import type { Message } from '../../core/types.js';
import type { Task, TaskDecision, TaskDecisionInput } from './types.js';

/** TaskManager LLM 的 System Prompt */
const SYSTEM_PROMPT = `你是一个任务管理器。你的职责是判断当前消息与已有任务的关系。

不要执行任何任务，只做分类和决策。输出纯 JSON，不要包含任何其他文字。

判断规则：
1. 如果有进行中的任务，且新消息与该任务无关 → 中断它
2. 如果有被中断的任务，且新消息要求继续 → 恢复它
3. 如果新消息明确表示不继续了 → 取消对应任务
4. 如果新消息描述了一个新的多步骤工作 → 新建任务
5. 如果新消息是对当前任务的反馈/补充 → 不中断，继续

关于注入上下文：
- 如果有活跃任务（进行中或被中断），注入上下文让主 LLM 知道
- 注入内容应包含：任务描述、当前状态、进展概况
- 如果有被中断的任务，注入中要说明"用户发了新消息，这个任务被中断了"

输出 JSON 格式：
{
  "injectTaskContext": boolean,
  "taskContext": "string（注入给主 LLM 的上下文，为空串则不注入）",
  "interruptedTasks": ["taskId1"],
  "newTask": "string（新任务描述，null 表示不新建）",
  "completesTask": "taskId（null 表示没有完成任务）",
  "resumeTask": "taskId（null 表示不恢复）",
  "cancelTask": "taskId（null 表示不取消）",
  "reason": "string（决策理由，简短）"
}`;

/** 默认 fallback 决策 */
const DEFAULT_DECISION: TaskDecision = {
  injectTaskContext: false,
  taskContext: '',
  interruptedTasks: [],
  newTask: null,
  completesTask: null,
  resumeTask: null,
  reason: 'TaskManager 未返回有效决策',
};

/**
 * TaskManager — 使用新架构 ModelProvider
 */
export class TaskManager {
  private provider: ModelProvider;
  private model: string;

  constructor(provider: ModelProvider, model: string) {
    this.provider = provider;
    this.model = model;
  }

  async decide(input: TaskDecisionInput): Promise<TaskDecision> {
    try {
      const userPrompt = this.buildUserPrompt(input);
      const request: LLMRequest = {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        maxTokens: 512,
        model: this.model,
      };

      const response = await this.provider.chat(request);
      return this.parseResponse(response.content);
    } catch (error) {
      console.error('[TaskManager] LLM call failed:', error);
      return DEFAULT_DECISION;
    }
  }

  private buildUserPrompt(input: TaskDecisionInput): string {
    const parts: string[] = [];

    if (input.currentTasks.length > 0) {
      parts.push('当前任务：');
      for (const task of input.currentTasks) {
        parts.push(`- [${task.id}] "${task.description}" (状态: ${task.status})`);
      }
    } else {
      parts.push('当前没有进行中的任务。');
    }

    if (input.recentContext) {
      parts.push('');
      parts.push('最近对话：');
      parts.push(input.recentContext);
    }

    parts.push('');
    parts.push(`新消息：${input.newMessage}`);

    return parts.join('\n');
  }

  private parseResponse(content: string): TaskDecision {
    try {
      const jsonMatches = content.matchAll(/\{[^{}]*\}/g);
      const matches = Array.from(jsonMatches);

      if (matches.length === 0) {
        console.warn('[TaskManager] No JSON found in response:', content);
        return DEFAULT_DECISION;
      }

      const lastMatch = matches[matches.length - 1][0];
      const parsed = JSON.parse(lastMatch);

      return {
        injectTaskContext: typeof parsed.injectTaskContext === 'boolean' ? parsed.injectTaskContext : false,
        taskContext: typeof parsed.taskContext === 'string' ? parsed.taskContext : '',
        interruptedTasks: Array.isArray(parsed.interruptedTasks) && parsed.interruptedTasks.every((t: any) => typeof t === 'string') ? parsed.interruptedTasks : [],
        newTask: typeof parsed.newTask === 'string' ? parsed.newTask : null,
        completesTask: typeof parsed.completesTask === 'string' ? parsed.completesTask : null,
        resumeTask: typeof parsed.resumeTask === 'string' ? parsed.resumeTask : null,
        cancelTask: typeof parsed.cancelTask === 'string' ? parsed.cancelTask : null,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'TaskManager 未返回有效决策',
      };
    } catch (error) {
      console.warn('[TaskManager] Failed to parse response:', content, error);
      return DEFAULT_DECISION;
    }
  }
}
