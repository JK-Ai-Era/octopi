/**
 * StrategyRouter 类型定义
 */

// ── 任务分类 ──

/** 任务复杂度 */
export type TaskComplexity = 'simple' | 'moderate' | 'complex';

/** 任务类型 */
export type TaskCategory =
  | 'question'       // 简单提问
  | 'lookup'         // 信息查询
  | 'analysis'       // 分析推理
  | 'creation'       // 创作生成
  | 'coding'         // 编程任务
  | 'planning'       // 规划分解
  | 'conversation'   // 闲聊
  | 'unknown';

/** 任务分类结果 */
export interface TaskClassification {
  /** 任务类型 */
  category: TaskCategory;
  /** 复杂度 */
  complexity: TaskComplexity;
  /** 置信度 0-1 */
  confidence: number;
  /** 是否需要工具 */
  needsTools: boolean;
  /** 是否需要规划 */
  needsPlanning: boolean;
  /** 推理 */
  reasoning?: string;
}

// ── 推理策略 ──

/** 推理策略类型 */
export type StrategyKind =
  | 'direct'          // 直接回答（简单问题）
  | 'chain_of_thought' // 思维链（需要推理）
  | 'plan_and_execute' // 规划执行（复杂任务）
  | 'tool_use'        // 工具优先（需要外部信息）
  | 'reflect'         // 反思循环（需要高质量）
  | 'multi_agent'     // 多 Agent 协作（超复杂任务）

/** 推理策略 */
export interface Strategy {
  /** 策略类型 */
  kind: StrategyKind;
  /** 策略名称 */
  name: string;
  /** 策略描述 */
  description: string;
  /** 系统提示词补充 */
  systemPromptAddition?: string;
  /** 最大迭代次数 */
  maxIterations?: number;
  /** 是否需要反思 */
  needsReflection?: boolean;
  /** 温度调整 */
  temperature?: number;
}

// ── TaskClassifier 接口 ──

export interface TaskClassifier {
  readonly name: string;
  classify(input: string, context?: Record<string, unknown>): Promise<TaskClassification>;
}

// ── StrategyRouter 接口 ──

export interface StrategyRouter {
  readonly name: string;
  select(classification: TaskClassification): Strategy;
}
