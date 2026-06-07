/**
 * Workflow 引擎 — 类型定义
 *
 * 基于 TaskTracker 的任务编排系统。
 * Workflow 是 Task 的上层抽象，定义执行顺序和条件分支。
 */

/** Workflow 步骤类型 */
export type StepType =
  | 'agent'        // Agent 执行
  | 'tool'         // 工具调用
  | 'condition'    // 条件判断
  | 'loop'         // 循环
  | 'parallel'     // 并行
  | 'human'        // 人工介入
  | 'subworkflow'; // 子 Workflow

/** 步骤状态 */
export type StepStatus =
  | 'pending'      // 等待执行
  | 'running'      // 执行中
  | 'completed'    // 已完成
  | 'failed'       // 失败
  | 'skipped'      // 跳过
  | 'cancelled';   // 取消

/** Workflow 状态 */
export type WorkflowStatus =
  | 'pending'      // 等待执行
  | 'running'      // 执行中
  | 'paused'       // 已暂停
  | 'completed'    // 已完成
  | 'failed'       // 失败
  | 'cancelled';   // 取消

/** 条件分支 */
export interface ConditionalNext {
  /** 条件表达式（返回 boolean） */
  condition: string | ((context: WorkflowContext) => boolean);
  /** 目标步骤 ID */
  target: string;
}

/** Workflow 步骤 */
export interface WorkflowStep {
  /** 步骤 ID */
  id: string;
  /** 步骤类型 */
  type: StepType;
  /** 步骤名称 */
  name: string;
  /** 步骤配置 */
  config: StepConfig;
  /** 下一步（字符串表示顺序执行，数组表示条件分支） */
  next?: string | ConditionalNext[];
  /** 错误处理策略 */
  onError?: 'retry' | 'skip' | 'abort' | string;
  /** 重试策略 */
  retryPolicy?: RetryPolicy;
  /** 步骤状态（运行时） */
  status?: StepStatus;
  /** 关联的 Task ID（运行时） */
  taskId?: string;
}

/** 重试策略 */
export interface RetryPolicy {
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试间隔（毫秒） */
  delayMs: number;
}

/** 步骤配置 */
export interface StepConfig {
  // Agent 步骤
  agentId?: string;
  prompt?: string;
  systemPrompt?: string;

  // Tool 步骤
  toolName?: string;
  toolArgs?: Record<string, unknown>;

  // 条件步骤
  expression?: string;
  llmJudge?: boolean;

  // 循环步骤
  maxIterations?: number;
  until?: string | ((context: WorkflowContext) => boolean);

  // 人工步骤
  approvalRequired?: boolean;
  approver?: string;

  // 通用
  timeout?: number;
  metadata?: Record<string, unknown>;
}

/** Workflow 定义 */
export interface WorkflowDefinition {
  /** Workflow ID */
  id: string;
  /** Workflow 名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 版本 */
  version: string;
  /** 步骤列表 */
  steps: WorkflowStep[];
  /** 起始步骤 ID */
  startStep: string;
  /** 初始变量 */
  variables?: Record<string, unknown>;
}

/** Workflow 执行上下文 */
export interface WorkflowContext {
  /** 变量 */
  variables: Map<string, unknown>;
  /** 当前步骤结果 */
  currentResult?: unknown;
  /** 步骤历史 */
  history: StepExecution[];
}

/** Workflow 执行实例 */
export interface WorkflowInstance {
  /** 实例 ID */
  id: string;
  /** Workflow 定义 ID */
  definitionId: string;
  /** 状态 */
  status: WorkflowStatus;
  /** 当前步骤 ID */
  currentStep: string;
  /** 变量 */
  variables: Map<string, unknown>;
  /** 步骤执行历史 */
  history: StepExecution[];
  /** 开始时间 */
  startedAt: number;
  /** 完成时间 */
  completedAt?: number;
}

/** 步骤执行记录 */
export interface StepExecution {
  /** 步骤 ID */
  stepId: string;
  /** 关联的任务 ID */
  taskId?: string;
  /** 执行状态 */
  status: StepStatus;
  /** 输入 */
  input?: unknown;
  /** 输出 */
  output?: unknown;
  /** 耗时（毫秒） */
  duration: number;
  /** 错误信息 */
  error?: string;
}

/** Workflow 事件 */
export interface WorkflowEvent {
  type: 'step.start' | 'step.complete' | 'step.fail' | 'workflow.complete' | 'workflow.fail' | 'human.required';
  instanceId: string;
  stepId?: string;
  data?: unknown;
}

/** 步骤执行器接口 */
export interface StepExecutor {
  /**
   * 执行步骤
   *
   * @param step - 步骤定义
   * @param context - 执行上下文
   * @returns 执行结果
   */
  execute(step: WorkflowStep, context: WorkflowContext): Promise<unknown>;
}
