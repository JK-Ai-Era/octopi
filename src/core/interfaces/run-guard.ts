/**
 * RunGuard — 过程监督接口
 *
 * 与 ResourceBudget 组合（非替代）：
 * - Budget：每轮资源 hard（wall-clock / iteration / tool_calls）
 * - RunGuard：周期性行为监督（continue / recover / stop）
 *
 * 设计原则：
 * - 单方法接口，Core 层极简风格
 * - 异步，支持 LLM 审查
 * - 返回值是 discriminated union，引擎据以执行动作
 * - 不读写 Session.tasks，不编排 Workflow
 * - 不拥有资源 hardLimit（资源总闸归 Budget）
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
  /** 连续 noop 次数（可选） */
  noopStreak?: number;
}

/** 恢复尝试记录（供升级阶梯） */
export interface RecoveryAttemptRecord {
  iteration: number;
  actionType: RecoveryAction['type'];
  reason: string;
  failureKind?: RunFailureKind;
  timestamp: number;
}

/** 检查点上下文 — 引擎传递给监督节点的信息 */
export interface CheckpointContext {
  /** Session ID */
  sessionId: string;
  /** Agent ID */
  agentId: string;
  /** 当前迭代次数（run 内全局，永不因检查点清零） */
  iteration: number;
  /** 总工具调用数 */
  totalToolCalls: number;
  /** 诊断：名义 token 总量（Σ nominal）；禁止作为 hard 单位 */
  nominalTotalTokens: number;
  /** 已运行时间（毫秒） */
  elapsedMs: number;
  /** 最近几轮的摘要 */
  recentSummaries: TurnSummary[];
  /** 关键指标 */
  metrics: CheckpointMetrics;
  /** 当前任务描述（如果有） */
  taskDescription?: string;
  /** 恢复历史（防止重复 hint；支撑升级） */
  recoveryHistory?: RecoveryAttemptRecord[];
  /** 外部高危信号（tool-loop / noop 等） */
  externalSignals?: Array<{ source: string; level: 'warning' | 'critical'; detail: string }>;
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

/** 失败形态 taxonomy（与 tool-loop / Security 对齐的共享词汇） */
export type RunFailureKind =
  | 'loop'
  | 'thrash'
  | 'drift'
  | 'stall'
  | 'blowup'
  | 'burn';

/** 检查点动作 */
export type CheckpointAction = 'continue' | 'recover' | 'stop';

/** 检查点裁决 — 监督节点的判断结果 */
export interface CheckpointVerdict {
  /** 动作 */
  action: CheckpointAction;
  /** 人类可读的原因 */
  reason: string;
  /** 失败形态（可选，便于策略与观测对齐） */
  failureKind?: RunFailureKind;
  /** recover 时的恢复动作列表 */
  recoveryActions?: RecoveryAction[];
  /** stop 时发送给用户的消息 */
  userMessage?: string;
  /** 可选：建议下一次检查点的间隔（迭代数） */
  nextCheckpointIn?: number;
}

// ── RunGuard 接口 ──

/**
 * RunGuard 接口
 *
 * Core 层在 Agent 的检查点调用此接口。
 * Harness 层实现具体策略（规则检测 + LLM 审查）。
 */
export interface RunGuard {
  /**
   * 检查点审查
   *
   * @param context - 检查点上下文（引擎提供的运行时信息）
   * @returns 裁决（continue / recover / stop）
   */
  checkpoint(context: CheckpointContext): Promise<CheckpointVerdict>;
}
