/**
 * HybridPlanner — 混合规划器
 *
 * 规则优先，LLM fallback。
 * 常见事件用规则快速处理，复杂情况交给 LLM。
 *
 * 策略：
 * 1. 先用 RulePlanner 匹配
 * 2. 如果规则匹配且生成了步骤 → 直接使用
 * 3. 如果没有匹配的规则 → fallback 到 LLMPlanner
 */

import type {
  Planner,
  Plan,
  AgentState,
} from '../supervisor/types.js';
import type { EventBusAgentEvent as AgentEvent } from '../../../core/index.js';
import { RulePlanner } from './rule-planner.js';
import { LLMPlanner } from './llm-planner.js';
import type { LLMPlannerConfig } from './llm-planner.js';
import type { Rule } from './rule-planner.js';
import { getDefaultRules } from './rule-planner.js';

// ── 配置 ──

export interface HybridPlannerConfig {
  /** LLM 配置（fallback 用） */
  llm: LLMPlannerConfig;
  /** 规则集（默认使用内置规则） */
  rules?: Rule[];
  /** 是否启用 LLM fallback（默认 true） */
  enableLLMFallback?: boolean;
}

// ── HybridPlanner ──

/**
 * 混合规划器
 *
 * 规则优先，LLM 兜底。
 */
export class HybridPlanner implements Planner {
  readonly name = 'hybrid-planner';
  private _rulePlanner: RulePlanner;
  private _llmPlanner: LLMPlanner;
  private _enableFallback: boolean;

  constructor(config: HybridPlannerConfig) {
    const rules = config.rules ?? getDefaultRules();
    this._rulePlanner = new RulePlanner(rules);
    this._llmPlanner = new LLMPlanner(config.llm);
    this._enableFallback = config.enableLLMFallback ?? true;
  }

  /**
   * 添加规则
   */
  addRule(rule: Rule): void {
    this._rulePlanner.addRule(rule);
  }

  /**
   * 分析事件：规则优先，LLM fallback
   */
  async decide(events: AgentEvent[], state: AgentState): Promise<Plan> {
    // 1. 先用规则匹配
    const rulePlan = await this._rulePlanner.decide(events, state);

    // 2. 如果规则匹配到了步骤，直接使用
    if (rulePlan.steps.length > 0) {
      return rulePlan;
    }

    // 3. 没有匹配的规则，fallback 到 LLM
    if (this._enableFallback) {
      return this._llmPlanner.decide(events, state);
    }

    // 4. 未启用 fallback，返回空计划
    return rulePlan;
  }

  /**
   * 目标分解：直接用 LLM（规则不擅长分解）
   */
  async decompose(goal: string, state: AgentState): Promise<Plan> {
    return this._llmPlanner.decompose(goal, state);
  }
}
