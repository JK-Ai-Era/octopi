/**
 * DefaultTaskSupervisor — 两层智能监督实现
 *
 * Layer 1: 规则检测（零 LLM 成本）
 *   - 检测重复模式、错误循环、token 暴涨、工具失败率
 *
 * Layer 2: LLM 审查（可选，低成本）
 *   - 规则层不确定时，用轻量模型做语义审查
 *
 * 设计原则：
 * - 快速路径优先：80% 的检查点在 Layer 1 就能判定
 * - 最小化 LLM 调用：只在规则层不确定或定期审查时才调用
 * - 摘要输入：LLM 审查只看摘要，不看全文，控制成本
 */

import type {
  TaskSupervisor,
  CheckpointContext,
  CheckpointVerdict,
  CheckpointMetrics,
  TurnSummary,
  RecoveryAction,
} from '../../../core/interfaces/task-supervisor.js';
import type { ModelProvider } from '../../../core/interfaces/model-provider.js';

// ── 配置 ──

/** TaskSupervisor 配置 */
export interface TaskSupervisorConfig {
  /** 是否启用（默认 true） */
  enabled?: boolean;
  /** 基础检查间隔（迭代数，默认 15） */
  checkpointInterval?: number;
  /** 最小检查间隔（默认 5） */
  minCheckpointInterval?: number;
  /** 最大检查间隔（默认 50） */
  maxCheckpointInterval?: number;
  /** 启用 LLM 审查（默认 true） */
  enableLLMReview?: boolean;
  /** LLM 审查频率（每 N 个检查点审查一次，默认 3） */
  llmReviewInterval?: number;
  /** 审查用的模型名（可选，默认用主模型） */
  llmModel?: string;
  /** 硬上限：最大迭代数（默认 1000） */
  hardLimit?: number;
  /** 硬上限：最大 wall-clock 时间（毫秒，默认 10 小时） */
  hardWallClockMs?: number;
  /** 每次检查点的回调（可用于日志、监控、用户通知） */
  onCheckpoint?: (ctx: CheckpointContext, verdict: CheckpointVerdict) => void;
}

const DEFAULT_CONFIG = {
  enabled: true,
  checkpointInterval: 15,
  minCheckpointInterval: 5,
  maxCheckpointInterval: 50,
  enableLLMReview: true,
  llmReviewInterval: 3,
  llmModel: '',
  hardLimit: 1000,
  hardWallClockMs: 36_000_000, // 10 小时
};

// ── 规则检测结果 ──

interface RuleCheckResult {
  triggered: boolean;
  severity: 'low' | 'medium' | 'high';
  rule: string;
  description: string;
  suggestedRecovery?: RecoveryAction[];
}

// ── 实现 ──

/**
 * DefaultTaskSupervisor
 *
 * 两层智能监督：规则检测 + LLM 审查
 */
export class DefaultTaskSupervisor implements TaskSupervisor {
  private config: TaskSupervisorConfig & { enabled: boolean; checkpointInterval: number; minCheckpointInterval: number; maxCheckpointInterval: number; enableLLMReview: boolean; llmReviewInterval: number; llmModel: string; hardLimit: number; hardWallClockMs: number };
  private model?: ModelProvider;
  private checkpointCount = 0;

  constructor(config?: TaskSupervisorConfig, model?: ModelProvider) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.model = model;
  }

  async checkpoint(context: CheckpointContext): Promise<CheckpointVerdict> {
    this.checkpointCount++;

    let verdict: CheckpointVerdict;

    // ── 硬上限检查（始终执行） ──
    if (context.iteration >= this.config.hardLimit) {
      verdict = {
        action: 'stop',
        reason: `硬上限触发：已运行 ${context.iteration} 轮（上限 ${this.config.hardLimit}）`,
        userMessage: `任务已运行 ${context.iteration} 轮，达到安全上限。如需继续，请优化任务后重新开始。`,
      };
    } else if (context.elapsedMs >= this.config.hardWallClockMs) {
      verdict = {
        action: 'stop',
        reason: `时间上限触发：已运行 ${Math.round(context.elapsedMs / 60000)} 分钟`,
        userMessage: `任务已运行 ${Math.round(context.elapsedMs / 60000)} 分钟，达到时间上限。`,
      };
    } else {
      // ── Layer 1: 规则检测 ──
      const ruleResults = this.runRuleChecks(context);
      const highSeverity = ruleResults.filter(r => r.triggered && r.severity === 'high');
      const mediumSeverity = ruleResults.filter(r => r.triggered && r.severity === 'medium');

      if (highSeverity.length > 0) {
        const recoveryActions = highSeverity.flatMap(r => r.suggestedRecovery ?? []);
        verdict = {
          action: 'recover',
          reason: highSeverity.map(r => `[${r.rule}] ${r.description}`).join('; '),
          recoveryActions: recoveryActions.length > 0 ? recoveryActions : undefined,
          nextCheckpointIn: this.config.minCheckpointInterval,
        };
      } else if (mediumSeverity.length > 0) {
        const recoveryActions = mediumSeverity.flatMap(r => r.suggestedRecovery ?? []);
        verdict = {
          action: 'recover',
          reason: mediumSeverity.map(r => `[${r.rule}] ${r.description}`).join('; '),
          recoveryActions: recoveryActions.length > 0 ? recoveryActions : undefined,
          nextCheckpointIn: Math.max(
            this.config.minCheckpointInterval,
            Math.floor(context.iteration * 0.5),
          ),
        };
      } else {
        // ── Layer 2: LLM 审查（可选） ──
        if (this.config.enableLLMReview && this.shouldLLMReview()) {
          try {
            const llmVerdict = await this.llmReview(context);
            if (llmVerdict.action !== 'continue') {
              verdict = llmVerdict;
            } else {
              verdict = this.normalVerdict(context);
            }
          } catch {
            verdict = this.normalVerdict(context);
          }
        } else {
          verdict = this.normalVerdict(context);
        }
      }
    }

    // ── 回调 ──
    if (this.config.onCheckpoint) {
      try {
        this.config.onCheckpoint(context, verdict);
      } catch {
        // 回调失败不影响主循环
      }
    }

    return verdict;
  }

  private normalVerdict(context: CheckpointContext): CheckpointVerdict {
    return {
      action: 'continue',
      reason: '正常运行',
      nextCheckpointIn: Math.min(
        this.config.maxCheckpointInterval,
        Math.floor(context.iteration * 1.2),
      ),
    };
  }

  // ── Layer 1: 规则检测 ──

  private runRuleChecks(ctx: CheckpointContext): RuleCheckResult[] {
    const m = ctx.metrics;
    const results: RuleCheckResult[] = [];

    // 规则 1: 重复工具循环
    if (m.consecutiveSameTool >= 5) {
      results.push({
        triggered: true,
        severity: 'high',
        rule: 'repeated_tool',
        description: `连续 ${m.consecutiveSameTool} 次调用同一工具，疑似陷入循环`,
        suggestedRecovery: [{ type: 'inject_hint', hint: '你似乎在同一工具上反复调用。请分析当前状态，尝试不同的方法或向用户报告遇到的问题。' }],
      });
    } else if (m.consecutiveSameTool >= 3) {
      results.push({
        triggered: true,
        severity: 'medium',
        rule: 'repeated_tool',
        description: `连续 ${m.consecutiveSameTool} 次调用同一工具`,
      });
    }

    // 规则 2: 错误循环
    if (m.consecutiveErrors >= 3) {
      results.push({
        triggered: true,
        severity: 'high',
        rule: 'error_loop',
        description: `连续 ${m.consecutiveErrors} 次错误，可能遇到了无法解决的问题`,
        suggestedRecovery: [{ type: 'inject_hint', hint: '你已连续遇到多次错误。请停下来分析错误原因，考虑换一种方法，或向用户报告当前遇到的困难。' }],
      });
    } else if (m.consecutiveErrors >= 2) {
      results.push({
        triggered: true,
        severity: 'medium',
        rule: 'error_loop',
        description: `连续 ${m.consecutiveErrors} 次错误`,
      });
    }

    // 规则 3: 工具失败率高
    if (m.toolFailureRate > 0.5 && ctx.recentSummaries.length >= 3) {
      results.push({
        triggered: true,
        severity: 'medium',
        rule: 'high_failure_rate',
        description: `工具失败率 ${(m.toolFailureRate * 100).toFixed(0)}%，执行质量下降`,
        suggestedRecovery: [{ type: 'inject_hint', hint: '最近工具调用失败率较高。请检查工具使用方式是否正确，或考虑是否需要换一种方法。' }],
      });
    }

    // 规则 4: Token 暴涨
    if (m.tokenGrowthRate > 0.5) {
      results.push({
        triggered: true,
        severity: 'medium',
        rule: 'token_growth',
        description: `Token 增长率 ${(m.tokenGrowthRate * 100).toFixed(0)}%，上下文可能膨胀`,
        suggestedRecovery: [{ type: 'truncate_context', keepRecent: 6 }],
      });
    }

    // 规则 5: 无进展
    if (!m.hasProgress && ctx.recentSummaries.length >= 3) {
      results.push({
        triggered: true,
        severity: 'low',
        rule: 'no_progress',
        description: '最近几轮没有实质进展',
      });
    }

    return results;
  }

  // ── Layer 2: LLM 审查 ──

  private shouldLLMReview(): boolean {
    // 每 N 个检查点审查一次
    return this.checkpointCount % this.config.llmReviewInterval === 0;
  }

  private async llmReview(ctx: CheckpointContext): Promise<CheckpointVerdict> {
    if (!this.model) {
      return { action: 'continue', reason: '无 LLM 模型，跳过审查' };
    }

    // 构建摘要 prompt
    const summaryText = ctx.recentSummaries
      .map((s, i) => {
        const tools = s.toolCalls?.length ? ` [工具: ${s.toolCalls.join(', ')}]` : '';
        const errors = s.toolErrors?.length ? ` [错误: ${s.toolErrors.join(', ')}]` : '';
        return `  ${i + 1}. [${s.role}]${tools}${errors} ${s.contentPreview || '(无文本)'}`;
      })
      .join('\n');

    const taskLine = ctx.taskDescription ? `\n当前任务: ${ctx.taskDescription}` : '';

    const prompt = `你是一个 Agent 运行监督器。你的职责是判断一个 AI Agent 是否在正常工作。

以下是 Agent 最近几轮的运行摘要：
${summaryText}${taskLine}

当前指标：
- 迭代次数: ${ctx.iteration}
- 连续错误: ${ctx.metrics.consecutiveErrors}
- 工具失败率: ${(ctx.metrics.toolFailureRate * 100).toFixed(0)}%
- Token 增长率: ${(ctx.metrics.tokenGrowthRate * 100).toFixed(0)}%
- 是否有进展: ${ctx.metrics.hasProgress ? '是' : '否'}
- 使用的不同工具数: ${ctx.metrics.uniqueToolsUsed}

判断标准：
- OK: Agent 在正常推进任务，有实质性进展
- CONCERN: <原因>: Agent 可能偏离目标、效率低下、或遇到困难
- STOP: <原因>: Agent 已陷入死循环、严重偏离目标、或无法继续

只回复一个词（OK/CONCERN/STOP），如果需要可以加冒号说明原因。`;

    try {
      const response = await this.model.chat({
        messages: [{ role: 'user', content: prompt }],
        model: this.config.llmModel || undefined,
        temperature: 0,
      });

      const text = response.content.trim().toUpperCase();

      if (text.startsWith('STOP')) {
        const reason = response.content.trim().replace(/^STOP:?\s*/i, '');
        return {
          action: 'stop',
          reason: `LLM 审查: ${reason}`,
          userMessage: `任务监督器判断任务可能异常，建议终止。原因: ${reason}`,
        };
      }

      if (text.startsWith('CONCERN')) {
        const reason = response.content.trim().replace(/^CONCERN:?\s*/i, '');
        return {
          action: 'recover',
          reason: `LLM 审查: ${reason}`,
          recoveryActions: [{ type: 'inject_hint', hint: `监督器提醒: ${reason}。请调整策略。` }],
        };
      }

      return { action: 'continue', reason: 'LLM 审查: 正常' };
    } catch {
      // LLM 调用失败（超时、网络错误等），不影响主循环
      return { action: 'continue', reason: 'LLM 审查失败，跳过' };
    }
  }
}

// ── 工厂函数 ──

/**
 * 创建 DefaultTaskSupervisor
 */
export function createTaskSupervisor(
  config?: TaskSupervisorConfig,
  model?: ModelProvider,
): DefaultTaskSupervisor {
  return new DefaultTaskSupervisor(config, model);
}
