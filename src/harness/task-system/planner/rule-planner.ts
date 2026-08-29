/**
 * RulePlanner — 规则驱动的规划器
 *
 * 用 if-then 规则处理常见事件，不需要 LLM 调用。
 * 快速、低成本、可预测。
 *
 * 适用场景：
 * - 用户消息 → 转发给 LLM 引擎处理
 * - 定时事件 → 执行预定义任务
 * - 安全事件 → 立即响应
 * - 子进程回报 → 更新状态
 *
 * 复杂场景 fallback 到 LLMPlanner。
 */

import { randomUUID } from 'node:crypto';
import type {
  Planner,
  Plan,
  PlanStep,
  AgentState,
} from '../supervisor/types.js';
import type { EventBusAgentEvent as AgentEvent } from '../../../core/index.js';

// ── 规则定义 ──

/** 规则匹配条件 */
export interface RuleCondition {
  /** 事件类型（支持前缀匹配：'user.*' 匹配所有 user 开头的事件） */
  eventType?: string | string[];
  /** 自定义条件函数 */
  custom?: (event: AgentEvent, state: AgentState) => boolean;
}

/** 规则动作 */
export interface RuleAction {
  /** 步骤类型 */
  type: PlanStep['type'];
  /** 步骤描述 */
  description: string;
  /** 步骤参数 */
  params?: Record<string, unknown>;
}

/** 规则 */
export interface Rule {
  /** 规则 ID */
  id: string;
  /** 规则名称 */
  name: string;
  /** 优先级（数字越大越先执行） */
  priority: number;
  /** 匹配条件 */
  when: RuleCondition;
  /** 匹配后生成的步骤 */
  then: RuleAction[];
  /** 是否只匹配一次 */
  once?: boolean;
}

// ── RulePlanner ──

/**
 * 规则驱动的规划器
 *
 * 按优先级遍历规则，第一个匹配的规则生成计划。
 */
export class RulePlanner implements Planner {
  readonly name = 'rule-planner';
  private _rules: Rule[] = [];
  private _firedOnce = new Set<string>();

  constructor(rules?: Rule[]) {
    if (rules) {
      this._rules = [...rules].sort((a, b) => b.priority - a.priority);
    }
  }

  /**
   * 添加规则
   */
  addRule(rule: Rule): void {
    this._rules.push(rule);
    this._rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 移除规则
   */
  removeRule(ruleId: string): void {
    this._rules = this._rules.filter(r => r.id !== ruleId);
  }

  /**
   * 分析事件，按规则生成计划
   */
  async decide(events: AgentEvent[], state: AgentState): Promise<Plan> {
    const steps: PlanStep[] = [];

    for (const event of events) {
      const rule = this._matchRule(event, state);
      if (rule) {
        // 标记 once 规则已触发
        if (rule.once) {
          this._firedOnce.add(rule.id);
        }

        // 生成步骤
        for (const action of rule.then) {
          steps.push({
            id: `step-${randomUUID().slice(0, 8)}`,
            description: action.description,
            type: action.type,
            params: {
              ...action.params,
              triggerEvent: event,
            },
            status: 'pending',
          });
        }
      }
    }

    return {
      id: `plan-${randomUUID().slice(0, 8)}`,
      goal: steps.length > 0 ? 'handle events by rules' : 'no matching rule',
      steps,
      currentStepIndex: 0,
      status: 'pending',
      createdAt: Date.now(),
    };
  }

  /**
   * 目标分解 — 规则驱动的规划器不支持目标分解
   * 返回单步骤计划，由调用方决定如何处理
   */
  async decompose(goal: string, _state: AgentState): Promise<Plan> {
    return {
      id: `plan-${randomUUID().slice(0, 8)}`,
      goal,
      steps: [{
        id: `step-${randomUUID().slice(0, 8)}`,
        description: goal,
        type: 'llm_call',
        params: { prompt: goal },
        status: 'pending',
      }],
      currentStepIndex: 0,
      status: 'pending',
      createdAt: Date.now(),
    };
  }

  // ── 内部方法 ──

  private _matchRule(event: AgentEvent, state: AgentState): Rule | null {
    for (const rule of this._rules) {
      // 跳过已触发的 once 规则
      if (rule.once && this._firedOnce.has(rule.id)) continue;

      if (this._matchCondition(rule.when, event, state)) {
        return rule;
      }
    }
    return null;
  }

  private _matchCondition(condition: RuleCondition, event: AgentEvent, state: AgentState): boolean {
    // 事件类型匹配
    if (condition.eventType) {
      const types = Array.isArray(condition.eventType) ? condition.eventType : [condition.eventType];
      const matched = types.some(t => {
        if (t.endsWith('*')) {
          return event.type.startsWith(t.slice(0, -1));
        }
        return event.type === t;
      });
      if (!matched) return false;
    }

    // 自定义条件
    if (condition.custom) {
      if (!condition.custom(event, state)) return false;
    }

    return true;
  }
}

// ── 内置规则 ──

/** 用户消息规则：转发给 LLM 引擎 */
export const USER_MESSAGE_RULE: Rule = {
  id: 'builtin:user-message',
  name: 'User Message → LLM',
  priority: 100,
  when: {
    eventType: 'user.message',
  },
  then: [{
    type: 'llm_call',
    description: 'Process user message with LLM',
    params: {},
  }],
};

/** 安全事件规则：立即标记 */
export const SECURITY_EVENT_RULE: Rule = {
  id: 'builtin:security',
  name: 'Security Event → Alert',
  priority: 200,
  when: {
    eventType: ['injection.*', 'policy.*', 'sensitive.*'],
  },
  then: [{
    type: 'custom',
    description: 'Handle security event',
    params: { action: 'alert' },
  }],
};

/** 空闲事件规则：无操作 */
export const IDLE_RULE: Rule = {
  id: 'builtin:idle',
  name: 'Idle → No-op',
  priority: 0,
  when: {
    eventType: 'supervisor.idle',
  },
  then: [],
};

/** 获取默认规则集 */
export function getDefaultRules(): Rule[] {
  return [SECURITY_EVENT_RULE, USER_MESSAGE_RULE, IDLE_RULE];
}
