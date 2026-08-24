/**
 * TaskSupervisor — 智能监督接口
 *
 * 替代 IterationBudget 的硬限制，通过检查点机制实现智能监督。
 * 引擎每 N 轮迭代调用一次 checkpoint()，监督节点根据上下文判断：
 * - continue: 正常，继续执行
 * - recover:  异常但可恢复，执行恢复动作后继续
 * - stop:     无法恢复，终止并通知用户
 *
 * 设计原则：
 * - 单方法接口，Core 层极简风格
 * - 异步，支持 LLM 审查
 * - 返回值是 discriminated union，引擎据以执行动作
 */

// ── 检查点上下文 ──

/** 单轮对话摘要 */
export interface TurnSummary {
  /** 角色 */
  role: 'assistant' | 'tool';
  /** 内容预览（前 200 字符） */
  contentPreview: string;
  /** 调用的工具名 */
  toolCalls?: string[];
  /** 失败的工具名 */
  toolErrors?: string[];
  /** 本轮 token 增量 */
  tokenDelta: number;
  /** 时间戳 */
  timestamp: number;
}

/** 检查点指标 */
export interface CheckpointMetrics {
  /** 连续错误数（模型错误 + 工具错误） */
  consecutiveErrors: number;
  /** 连续调用同一工具的次数 */
  consecutiveSameTool: number;
  /** 最近 5 轮 token 增长率（0-1，如 0.5 = 增长 50%） */
  tokenGrowthRate: number;
  /** 最近 10 次工具调用的失败率（0-1） */
  toolFailureRate: number;
  /** 使用了多少种不同工具 */
  uniqueToolsUsed: number;
  /** 最近几轮是否有实质进展（新内容或新工具调用） */
  hasProgress: boolean;
}

/** 检查点上下文 — 引擎传递给监督节点的信息 */
export interface CheckpointContext {
  /** Session ID */
  sessionId: string;
  /** Agent ID */
  agentId: string;
  /** 当前迭代次数 */
  iteration: number;
  /** 总工具调用数 */
  totalToolCalls: number;
  /** 总 token 消耗 */
  totalTokens: number;
  /** 已运行时间（毫秒） */
  elapsedMs: number;
  /** 最近几轮的摘要 */
  recentSummaries: TurnSummary[];
  /** 关键指标 */
  metrics: CheckpointMetrics;
  /** 当前任务描述（如果有） */
  taskDescription?: string;
}

// ── 恢复动作 ──

/** 恢复动作 */
export type RecoveryAction =
  /** 截断上下文，保留最近 N 条消息 */
  | { type: 'truncate_context'; keepRecent: number }
  /** 注入提示信息，引导 Agent 回到正轨 */
  | { type: 'inject_hint'; hint: string }
  /** 清除最近 N 轮对话（去除误导性上下文） */
  | { type: 'clear_recent_turns'; count: number };

// ── 检查点裁决 ──

/** 检查点动作 */
export type CheckpointAction = 'continue' | 'recover' | 'stop';

/** 检查点裁决 — 监督节点的判断结果 */
export interface CheckpointVerdict {
  /** 动作 */
  action: CheckpointAction;
  /** 人类可读的原因 */
  reason: string;
  /** recover 时的恢复动作列表 */
  recoveryActions?: RecoveryAction[];
  /** stop 时发送给用户的消息 */
  userMessage?: string;
  /** 可选：建议下一次检查点的间隔（迭代数） */
  nextCheckpointIn?: number;
}

// ── TaskSupervisor 接口 ──

/**
 * TaskSupervisor 接口
 *
 * Core 层在 Agent 的检查点调用此接口。
 * Harness 层实现具体策略（规则检测 + LLM 审查）。
 */
export interface TaskSupervisor {
  /**
   * 检查点审查
   *
   * @param context - 检查点上下文（引擎提供的运行时信息）
   * @returns 裁决（continue / recover / stop）
   */
  checkpoint(context: CheckpointContext): Promise<CheckpointVerdict>;
}
