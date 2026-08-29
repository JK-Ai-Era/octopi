/**
 * DefaultStrategyRouter — 默认策略路由器
 *
 * 根据任务分类选择最合适的推理策略。
 */

import type {
  StrategyRouter,
  Strategy,
  TaskClassification,
  StrategyKind,
} from './types.js';

// ── 默认策略集 ──

const STRATEGIES: Record<StrategyKind, Strategy> = {
  direct: {
    kind: 'direct',
    name: '直接回答',
    description: '简单问题，直接回答不需要推理链',
    maxIterations: 1,
    temperature: 0.3,
  },
  chain_of_thought: {
    kind: 'chain_of_thought',
    name: '思维链',
    description: '需要逐步推理的问题',
    systemPromptAddition: '请一步步思考，展示你的推理过程。',
    maxIterations: 1,
    temperature: 0.5,
  },
  plan_and_execute: {
    kind: 'plan_and_execute',
    name: '规划执行',
    description: '复杂任务，先规划再执行',
    systemPromptAddition: '先制定计划，分解为步骤，然后逐步执行。',
    maxIterations: 10,
    needsReflection: true,
    temperature: 0.4,
  },
  tool_use: {
    kind: 'tool_use',
    name: '工具优先',
    description: '需要外部信息或执行操作',
    systemPromptAddition: '优先使用工具获取信息和执行操作。',
    maxIterations: 5,
    temperature: 0.3,
  },
  reflect: {
    kind: 'reflect',
    name: '反思循环',
    description: '需要高质量输出，执行后反思改进',
    systemPromptAddition: '完成任务后，检查输出质量，必要时改进。',
    maxIterations: 3,
    needsReflection: true,
    temperature: 0.5,
  },
  multi_agent: {
    kind: 'multi_agent',
    name: '多 Agent 协作',
    description: '超复杂任务，分派给多个子 Agent',
    systemPromptAddition: '将任务分解，分配给专门的子 Agent 处理。',
    maxIterations: 15,
    needsReflection: true,
    temperature: 0.4,
  },
};

// ── 路由规则 ──

interface RouteRule {
  match: (c: TaskClassification) => boolean;
  strategy: StrategyKind;
}

const ROUTE_RULES: RouteRule[] = [
  // 简单对话 → 直接回答
  { match: c => c.complexity === 'simple' && c.category === 'conversation', strategy: 'direct' },
  { match: c => c.complexity === 'simple' && c.category === 'question', strategy: 'direct' },

  // 查询 → 工具优先
  { match: c => c.category === 'lookup' || c.needsTools, strategy: 'tool_use' },

  // 分析 → 思维链
  { match: c => c.category === 'analysis', strategy: 'chain_of_thought' },

  // 规划 → 规划执行
  { match: c => c.needsPlanning || c.category === 'planning', strategy: 'plan_and_execute' },

  // 复杂编码 → 规划执行
  { match: c => c.complexity === 'complex' && c.category === 'coding', strategy: 'plan_and_execute' },

  // 复杂创作 → 反思循环
  { match: c => c.complexity === 'complex' && c.category === 'creation', strategy: 'reflect' },

  // 中等复杂度 → 思维链
  { match: c => c.complexity === 'moderate', strategy: 'chain_of_thought' },

  // 默认 → 直接回答
  { match: () => true, strategy: 'direct' },
];

// ── DefaultStrategyRouter ──

export class DefaultStrategyRouter implements StrategyRouter {
  readonly name = 'default-router';
  private _customStrategies: Map<StrategyKind, Strategy>;
  private _rules: RouteRule[];

  constructor(options?: { strategies?: Partial<Record<StrategyKind, Strategy>>; rules?: RouteRule[] }) {
    this._customStrategies = new Map(Object.entries(options?.strategies ?? []) as [StrategyKind, Strategy][]);
    this._rules = options?.rules ?? ROUTE_RULES;
  }

  /**
   * 根据分类选择策略
   */
  select(classification: TaskClassification): Strategy {
    for (const rule of this._rules) {
      if (rule.match(classification)) {
        const custom = this._customStrategies.get(rule.strategy);
        return custom ?? STRATEGIES[rule.strategy];
      }
    }
    return STRATEGIES.direct;
  }

  /**
   * 获取所有可用策略
   */
  listStrategies(): Strategy[] {
    return Object.values(STRATEGIES);
  }
}
