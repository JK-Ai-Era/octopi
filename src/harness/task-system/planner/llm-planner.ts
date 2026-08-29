/**
 * LLMPlanner — LLM 驱动的规划器
 *
 * 用 LLM 分析事件和状态，决定下一步行动。
 * 比规则驱动更灵活，但更慢、更贵。
 *
 * 适用场景：
 * - 复杂的用户请求（需要理解意图）
 * - 目标分解（大任务拆成小步骤）
 * - 异常情况处理（规则没覆盖的场景）
 */

import { randomUUID } from 'node:crypto';
import type {
  Planner,
  Plan,
  PlanStep,
  AgentState,
} from '../supervisor/types.js';
import type { EventBusAgentEvent as AgentEvent } from '../../../core/index.js';
import type { ModelProvider, LLMRequest } from '../../../core/interfaces/model-provider.js';

// ── 配置 ──

export interface LLMPlannerConfig {
  /** ModelProvider 实例 */
  model: ModelProvider;
  /** 使用的模型名 */
  modelName?: string;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 温度 */
  temperature?: number;
  /** 最大 token */
  maxTokens?: number;
}

// ── LLMPlanner ──

/**
 * LLM 驱动的规划器
 *
 * 将事件和状态序列化为 prompt，让 LLM 返回结构化的计划。
 */
export class LLMPlanner implements Planner {
  readonly name = 'llm-planner';
  private _model: ModelProvider;
  private _modelName?: string;
  private _systemPrompt: string;
  private _temperature: number;
  private _maxTokens: number;

  constructor(config: LLMPlannerConfig) {
    this._model = config.model;
    this._modelName = config.modelName;
    this._systemPrompt = config.systemPrompt ?? DEFAULT_PLANNER_PROMPT;
    this._temperature = config.temperature ?? 0.3;
    this._maxTokens = config.maxTokens ?? 2000;
  }

  /**
   * 分析事件，让 LLM 决定下一步
   */
  async decide(events: AgentEvent[], state: AgentState): Promise<Plan> {
    const prompt = this._buildDecidePrompt(events, state);
    const response = await this._callLLM(prompt);
    return this._parsePlan(response, 'decide events');
  }

  /**
   * 将目标分解为可执行步骤
   */
  async decompose(goal: string, state: AgentState): Promise<Plan> {
    const prompt = this._buildDecomposePrompt(goal, state);
    const response = await this._callLLM(prompt);
    return this._parsePlan(response, goal);
  }

  // ── 内部方法 ──

  private _buildDecidePrompt(events: AgentEvent[], state: AgentState): string {
    const eventSummary = events.map(e =>
      `- [${e.type}] ${e.data?.content ?? e.data?.description ?? JSON.stringify(e.data ?? {}).slice(0, 200)}`
    ).join('\n');

    return `你是一个 Agent 规划器。分析以下事件，决定下一步行动。

## 待处理事件
${eventSummary}

## Agent 状态
- 活跃计划: ${state.activePlan ? state.activePlan.goal : '无'}
- 最近执行次数: ${state.stats.totalExecutions}
- 最近错误次数: ${state.stats.totalErrors}

## 输出格式
返回 JSON，格式如下：
{
  "goal": "计划目标",
  "steps": [
    {
      "description": "步骤描述",
      "type": "llm_call | tool_call | wait | custom",
      "params": {}
    }
  ]
}

如果不需要任何行动，返回空 steps 数组。
只返回 JSON，不要其他文字。`;
  }

  private _buildDecomposePrompt(goal: string, state: AgentState): string {
    return `你是一个 Agent 规划器。将以下目标分解为可执行的步骤。

## 目标
${goal}

## Agent 状态
- 最近执行次数: ${state.stats.totalExecutions}

## 输出格式
返回 JSON，格式如下：
{
  "goal": "${goal}",
  "steps": [
    {
      "description": "步骤描述",
      "type": "llm_call | tool_call | wait | custom",
      "params": {}
    }
  ]
}

步骤应该具体、可执行、有序。
只返回 JSON，不要其他文字。`;
  }

  private async _callLLM(prompt: string): Promise<string> {
    const request: LLMRequest = {
      messages: [
        { role: 'system', content: this._systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: this._temperature,
      maxTokens: this._maxTokens,
      model: this._modelName,
    };

    const response = await this._model.chat(request);
    return response.content;
  }

  private _parsePlan(response: string, goal: string): Plan {
    try {
      // 尝试从响应中提取 JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this._emptyPlan(goal, 'No JSON in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const steps: PlanStep[] = (parsed.steps ?? []).map((s: Record<string, unknown>, i: number) => ({
        id: `step-${randomUUID().slice(0, 8)}`,
        description: (s.description as string) ?? `Step ${i + 1}`,
        type: this._validateStepType(s.type as string),
        params: (s.params as Record<string, unknown>) ?? {},
        status: 'pending' as const,
      }));

      return {
        id: `plan-${randomUUID().slice(0, 8)}`,
        goal: (parsed.goal as string) ?? goal,
        steps,
        currentStepIndex: 0,
        status: 'pending',
        createdAt: Date.now(),
      };
    } catch {
      return this._emptyPlan(goal, 'Failed to parse LLM response');
    }
  }

  private _validateStepType(type: string): PlanStep['type'] {
    const valid: PlanStep['type'][] = ['llm_call', 'tool_call', 'spawn_agent', 'wait', 'custom'];
    return valid.includes(type as PlanStep['type']) ? (type as PlanStep['type']) : 'llm_call';
  }

  private _emptyPlan(goal: string, reason: string): Plan {
    return {
      id: `plan-${randomUUID().slice(0, 8)}`,
      goal,
      steps: [],
      currentStepIndex: 0,
      status: 'completed',
      createdAt: Date.now(),
    };
  }
}

// ── 默认系统提示 ──

const DEFAULT_PLANNER_PROMPT = `你是一个 Agent 规划器。你的任务是分析事件并决定 Agent 应该做什么。

规则：
1. 只生成必要的步骤，避免冗余
2. 每个步骤应该是独立可执行的
3. 优先使用已有的工具和能力
4. 遇到不确定的情况，倾向于询问用户而不是猜测
5. 安全事件需要立即响应`;
