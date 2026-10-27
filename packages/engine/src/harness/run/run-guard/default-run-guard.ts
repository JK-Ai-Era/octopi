/**
 * DefaultRunGuard — 两层智能过程监督实现
 *
 * 与 ResourceBudget 组合（非替代）：Budget 管资源 hard，本类管行为跑飞。
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
 * - hardLimit/hardWallClockMs 保留为可选兜底；资源总闸优先归 Budget
 */

import type {
  RunGuard,
  CheckpointContext,
  CheckpointVerdict,
  CheckpointMetrics,
  TurnSummary,
  RecoveryAction,
  RunFailureKind,
} from '@octopi-agent/core/interfaces/run-guard.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';

// ── 配置 ──

/** RunGuard 配置 */
export interface RunGuardConfig {
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
  /**
   * 硬上限：最大迭代数。
   * 默认关闭（资源总闸归 ResourceBudget）；仅显式配置时兜底。
   */
  hardLimit?: number;
  /**
   * 硬上限：最大 wall-clock（毫秒）。
   * 默认关闭；资源总闸归 ResourceBudget。
   */
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
} as const;

// ── 规则检测结果 ──

interface RuleCheckResult {
  triggered: boolean;
  severity: 'low' | 'medium' | 'high';
  rule: string;
  description: string;
  failureKind: RunFailureKind;
  suggestedRecovery?: RecoveryAction[];
}

// ── 实现 ──

/**
 * DefaultRunGuard
 *
 * 两层智能监督：规则检测 + LLM 审查
 */
/** 指标生产者未提供 consecutiveIdenticalCalls 时只告警一次（防日志刷屏） */
let warnedMissingIdenticalMetric = false;

/** 指标生产者未提供 toolCallsInWindow 时只告警一次 */
let warnedMissingWindowMetric = false;

/** 指标生产者未提供 consecutiveIdenticalFailures 时只告警一次 */
let warnedMissingFailureMetric = false;

/**
 * 连续工具失败兜底阈值（错误内容各不相同时）
 *
 * 取高位：正常调试节奏是「跑测试红 → 改 → 再跑」，3~5 次连续失败很常见；
 * 8 次连续失败且一次都没成功，更像是工具/环境整体不可用，而不是在探索。
 */
const ERROR_STREAK_SAFETY = 8;

export class DefaultRunGuard implements RunGuard {
  private config: RunGuardConfig & {
    enabled: boolean;
    checkpointInterval: number;
    minCheckpointInterval: number;
    maxCheckpointInterval: number;
    enableLLMReview: boolean;
    llmReviewInterval: number;
    llmModel: string;
  };
  private model?: ModelProvider;
  private checkpointCount = 0;

  constructor(config?: RunGuardConfig, model?: ModelProvider) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.model = model;
  }

  async checkpoint(context: CheckpointContext): Promise<CheckpointVerdict> {
    this.checkpointCount++;

    let verdict: CheckpointVerdict;

    // ── 可选资源兜底（默认关闭；总闸归 ResourceBudget） ──
    if (this.config.hardLimit !== undefined && context.iteration >= this.config.hardLimit) {
      verdict = {
        action: 'stop',
        failureKind: 'burn',
        reason: `硬上限触发：已运行 ${context.iteration} 轮（上限 ${this.config.hardLimit}）`,
        userMessage: `任务已运行 ${context.iteration} 轮，达到安全上限。如需继续，请优化任务后重新开始。`,
      };
    } else if (
      this.config.hardWallClockMs !== undefined &&
      context.elapsedMs >= this.config.hardWallClockMs
    ) {
      verdict = {
        action: 'stop',
        failureKind: 'burn',
        reason: `时间上限触发：已运行 ${Math.round(context.elapsedMs / 60000)} 分钟`,
        userMessage: `任务已运行 ${Math.round(context.elapsedMs / 60000)} 分钟，达到时间上限。`,
      };
    } else {
      // ── Layer 1: 规则检测 ──
      const ruleResults = this.runRuleChecks(context);
      const highSeverity = ruleResults.filter(r => r.triggered && r.severity === 'high');
      const mediumSeverity = ruleResults.filter(r => r.triggered && r.severity === 'medium');

      if (highSeverity.length > 0 || mediumSeverity.length > 0) {
        const picked = highSeverity.length > 0 ? highSeverity : mediumSeverity;
        const recoveryActions = picked.flatMap(r => r.suggestedRecovery ?? []);
        const failureKind = picked[0].failureKind;
        const reason = picked.map(r => `[${r.rule}] ${r.description}`).join('; ');

        // 升级阶梯：同一 failureKind 连续 recover 达阈值 → stop
        const escalate = this.shouldEscalateToStop(context, failureKind);
        if (escalate) {
          verdict = {
            action: 'stop',
            failureKind,
            reason: `${reason}；已连续 recover ${escalate.count} 次仍无改善`,
            userMessage: `监督器已多次尝试恢复（${failureKind}），仍无法回到正轨，任务已停止。原因：${reason}`,
          };
        } else {
          // recover 升级：第 3 次起建议 truncate/clear
          const actions =
            this.countRecentSameKind(context, failureKind) >= 2
              ? [
                  { type: 'clear_recent_turns' as const, count: 2 },
                  ...recoveryActions.slice(0, 1),
                ]
              : recoveryActions.length > 0
                ? recoveryActions
                : undefined;
          verdict = {
            action: 'recover',
            failureKind,
            reason,
            recoveryActions: actions,
            nextCheckpointIn:
              highSeverity.length > 0
                ? this.config.minCheckpointInterval
                : Math.max(
                    this.config.minCheckpointInterval,
                    Math.floor(context.iteration * 0.5) || this.config.minCheckpointInterval,
                  ),
          };
        }
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
    const next = Math.min(
      this.config.maxCheckpointInterval,
      Math.max(this.config.minCheckpointInterval, Math.floor(context.iteration * 1.2) || this.config.checkpointInterval),
    );
    return {
      action: 'continue',
      reason: '正常运行',
      nextCheckpointIn: next,
    };
  }

  /** 同一 failureKind 最近 recover 次数（从末尾连续计数） */
  private countRecentSameKind(ctx: CheckpointContext, kind: RunFailureKind): number {
    const hist = ctx.recoveryHistory ?? [];
    let count = 0;
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i].failureKind === kind) count++;
      else break;
    }
    return count;
  }

  /**
   * 是否应升级为 stop
   * 同一 failureKind 连续 recover ≥3 次 → stop
   */
  private shouldEscalateToStop(
    ctx: CheckpointContext,
    kind: RunFailureKind,
  ): { count: number } | false {
    const count = this.countRecentSameKind(ctx, kind);
    if (count >= 3) return { count };
    return false;
  }

  // ── Layer 1: 规则检测 ──

  private runRuleChecks(ctx: CheckpointContext): RuleCheckResult[] {
    const m = ctx.metrics;
    const results: RuleCheckResult[] = [];

    // 外部高危信号（tool-loop critical 等）→ 立即按 loop 处理
    const criticalSignals = (ctx.externalSignals ?? []).filter(s => s.level === 'critical');
    if (criticalSignals.length > 0) {
      results.push({
        triggered: true,
        severity: 'high',
        rule: 'external_critical',
        description: criticalSignals.map(s => `[${s.source}] ${s.detail}`).join('; '),
        failureKind: 'loop',
        suggestedRecovery: [
          {
            type: 'inject_hint',
            hint: '检测到严重循环/卡死信号。请停止重复调用，换一种方法或向用户报告。',
          },
        ],
      });
    }

    // 规则 1: 无进展重复调用
    //
    // 判据只能是「工具名 + 参数 + 结果」三者一致（consecutiveIdenticalCalls）：
    // 编码类 run 会连续多次调用 shell / file_edit，但每次参数不同（改一行→跑一次
    // typecheck→再改），这属于正常推进。只看工具名的旧判据会把它误判为死循环，
    // 连续 3 次 recover 后升级为 stop，把正常任务静默掐断。
    //
    // 纯「同名不同参」不再产生规则结果：裁决只消费 high/medium（见 checkpoint），
    // 造一条 low 规则是死代码。需要观测时看 run_guard_metrics 的 consecutiveSameTool。
    const identicalCalls = m.consecutiveIdenticalCalls;
    if (identicalCalls === undefined && !warnedMissingIdenticalMetric) {
      // 指标生产者未升级时判据会静默空转；宁可漏报也不能退回「同名即循环」的误杀。
      warnedMissingIdenticalMetric = true;
      console.warn(
        '[RunGuard] CheckpointMetrics.consecutiveIdenticalCalls 缺失，repeated_identical_call 判据暂不生效',
      );
    }
    if ((identicalCalls ?? 0) >= 5) {
      results.push({
        triggered: true,
        severity: 'high',
        rule: 'repeated_identical_call',
        description: `连续 ${identicalCalls} 次相同调用（同一工具、同一参数、同一结果），无进展`,
        failureKind: 'loop',
        suggestedRecovery: [{ type: 'inject_hint', hint: '你的调用参数与结果都没有变化，说明这个方法无法推进。请改变做法，或向用户报告当前阻塞点。' }],
      });
    }

    // 规则 2: 错误循环 —— 判「错误是否重复」，不是「失败了几次」
    //
    // 旧判据 `consecutiveErrors >= 3` 只看连续失败次数：跑测试 A 红 → 改 → 跑测试 B 红
    // → 改 → 跑测试 C 红，三次失败但每次错误都不同，这是正常调试节奏（红-改-绿循环），
    // 却被判 high/blowup → recover，同 kind 连续 3 次后升级 stop。
    //
    // 「卡住」的真实特征是**同一个错误反复出现**：同一工具、同一参数、同一错误内容，
    // 说明重试没有换方法。故判据改为 consecutiveIdenticalFailures。
    //
    // 保留一条兜底：完全不同错误也可能整体失败（例如工具被全局配置坏掉），
    // 用较高的阈值兜住，普通调试节奏（3 个红测试）远达不到。
    const identicalFailures = m.consecutiveIdenticalFailures;
    if (identicalFailures === undefined && !warnedMissingFailureMetric) {
      warnedMissingFailureMetric = true;
      console.warn(
        '[RunGuard] CheckpointMetrics.consecutiveIdenticalFailures 缺失，error_loop 判据退化为连续失败兜底',
      );
    }
    if ((identicalFailures ?? 0) >= 3) {
      results.push({
        triggered: true,
        severity: 'high',
        rule: 'error_loop',
        description: `同一错误连续 ${identicalFailures} 次（工具、参数、错误内容均未变化），重试没有换方法`,
        failureKind: 'blowup',
        suggestedRecovery: [{ type: 'inject_hint', hint: '你正在用同样的方式重试同一个失败。请改变做法：读完整错误信息、检查前提假设，或者换个工具/思路；确实解决不了就向用户报告。' }],
      });
    } else if ((identicalFailures ?? 0) >= 2) {
      results.push({
        triggered: true,
        severity: 'medium',
        rule: 'error_loop',
        description: `同一错误连续 ${identicalFailures} 次`,
        failureKind: 'blowup',
      });
    } else if (m.consecutiveErrors >= ERROR_STREAK_SAFETY) {
      // 连续失败但错误各不相同：可能是探索，也可能整体环境坏了。兜底阈值取高位。
      results.push({
        triggered: true,
        severity: 'high',
        rule: 'error_streak',
        description: `连续 ${m.consecutiveErrors} 次工具调用失败（错误内容各不相同）`,
        failureKind: 'blowup',
        suggestedRecovery: [{ type: 'inject_hint', hint: '你已经连续多次工具调用失败。请先确认工具本身可用（最小示例验证），或向用户报告当前环境问题。' }],
      });
    }

    // 规则 3: 工具失败率高 —— 只有「高失败率 + 完全无推进」才算 thrash
    //
    // 失败率高本身不是行为异常：编码类 run 里跑测试/编译得红是工作的组成部分
    // （先写失败用例再实现、按错误信息反复调试），失败的调用与成功的编辑交替出现，
    // hasProgress 为 true。旧判据只看 `toolFailureRate > 0.5`，会把这类正常 turn
    // 判成 thrash → recover；同 kind 连续 3 次 recover 时还会 `clear_recent_turns`，
    // 把 agent 刚做完的进度从上下文里抹掉，比直接 stop 更隐蔽。
    //
    // 真正的 thrash 特征是「失败没有换来任何推进」：窗口内失败占比过半，
    // 且最近三轮没有任何成功工具或实质文本。
    //
    // 另需样本量下限：失败率是比值，只调用 2 次且都失败也是 100%，不构成证据。
    const windowCalls = m.toolCallsInWindow;
    if (windowCalls === undefined && !warnedMissingWindowMetric) {
      warnedMissingWindowMetric = true;
      console.warn(
        '[RunGuard] CheckpointMetrics.toolCallsInWindow 缺失，high_failure_rate 判据暂不生效',
      );
    }
    if (
      m.toolFailureRate > 0.5 &&
      (windowCalls ?? 0) >= 5 &&
      !m.hasProgress &&
      ctx.recentSummaries.length >= 3
    ) {
      results.push({
        triggered: true,
        severity: 'medium',
        rule: 'high_failure_rate',
        description: `工具失败率 ${(m.toolFailureRate * 100).toFixed(0)}%（窗口 ${windowCalls} 次）且最近无进展`,
        failureKind: 'thrash',
        suggestedRecovery: [{ type: 'inject_hint', hint: '最近的工具调用大量失败，且没有取得任何进展。请停下来定位失败根因（读完整错误信息、确认前提假设是否正确），或向用户报告当前阻塞点。' }],
      });
    }

    // 规则 4（token_growth）与规则 5（no_progress）已移除，原因分别是判据错位与功能重复：
    //
    // - 旧规则 4 用 `tokenGrowthRate > 0.5` 判「上下文膨胀」，但该指标是
    //   「最近半窗 token 消耗 ÷ 前一半 − 1」，衡量的是**消耗增速**而非上下文**绝对大小**。
    //   实测两个长 turn 的上下文分别涨到 10 倍和 2 倍，该值仅 0.08 / 0.03 —— 真正的膨胀
    //   它看不见；对「单轮读了个大文件」这种正常工作反而敏感。
    //   而它想管的事已由 wrap-up 的 context 轴无条件处理（`relConfig.wrapUp.contextRatio`
    //   默认 0.85，动作为进入收尾模式、让 agent 输出结论），比 `truncate_context` 更好：
    //   后者用 `messages.splice()` 整段替换历史中部，会打穿前缀缓存（B0 红线）。
    //   `tokenGrowthRate` 指标本身保留，仅作观测（run_guard_metrics），不参与裁决。
    //
    // - 旧规则 5 的两个分支都不生效：`low` 没有任何消费方（裁决只取 high/medium）；
    //   `medium` 要求 `noopStreak >= 3`，而 run-agent 在 `consecutiveNoops >= noopThreshold`
    //   时已设置 `_noopLoopStop` 并发出可见停止事件，`shouldStopAfterTurn` 直接结束 turn，
    //   本规则只是重复判定，还会多注入一条 hint、污染 recoveryHistory。
    //
    // 结论：真正需要 Guard 的异常只有三类——同参同结果（无进展循环）、同参同错误（没换方法）、
    // 高失败率且无推进（thrash）。上下文压力归 wrap-up / Budget，noop 归 run-agent。

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

    const recoveryLine =
      ctx.recoveryHistory && ctx.recoveryHistory.length > 0
        ? `\n最近恢复尝试:\n${ctx.recoveryHistory
            .slice(-5)
            .map(
              (h, i) =>
                `  ${i + 1}. [iter ${h.iteration}] ${h.actionType}${h.failureKind ? ` (${h.failureKind})` : ''}: ${h.reason}`,
            )
            .join('\n')}`
        : '';

    const signalsLine =
      ctx.externalSignals && ctx.externalSignals.length > 0
        ? `\n外部信号:\n${ctx.externalSignals
            .map(s => `  - [${s.level}] ${s.source}: ${s.detail}`)
            .join('\n')}`
        : '';

    const prompt = `你是一个 Agent 运行监督器。你的职责是判断一个 AI Agent 是否在正常工作。

以下是 Agent 最近几轮的运行摘要：
${summaryText}${taskLine}${recoveryLine}${signalsLine}

当前指标：
- 迭代次数: ${ctx.iteration}
- 连续错误: ${ctx.metrics.consecutiveErrors}
- 连续同一错误: ${ctx.metrics.consecutiveIdenticalFailures ?? '(未提供)'}
- 工具失败率: ${(ctx.metrics.toolFailureRate * 100).toFixed(0)}%（窗口 ${ctx.metrics.toolCallsInWindow ?? '?'} 次）
- 是否有进展: ${ctx.metrics.hasProgress ? '是' : '否'}
- 使用的不同工具数: ${ctx.metrics.uniqueToolsUsed}

判断标准：
- OK: Agent 在正常推进任务，有实质性进展
- CONCERN: <原因>: Agent 可能偏离目标、效率低下、或遇到困难
- STOP: <原因>: Agent 已陷入死循环、严重偏离目标、或无法继续

只回复一个词（OK/CONCERN/STOP），如果需要可以加冒号说明原因。`;

    try {
      // 不指定温度：由模型配置（ModelInfo.temperature）或服务端默认决定
      const response = await this.model.chat({
        messages: [{ role: 'user', content: prompt }],
        model: this.config.llmModel || undefined,
      });

      const text = response.content.trim().toUpperCase();

      if (text.startsWith('STOP')) {
        const reason = response.content.trim().replace(/^STOP:?\s*/i, '');
        return {
          action: 'stop',
          failureKind: 'drift',
          reason: `LLM 审查: ${reason}`,
          userMessage: `任务监督器判断任务可能异常，建议终止。原因：${reason}`,
        };
      }

      if (text.startsWith('CONCERN')) {
        const reason = response.content.trim().replace(/^CONCERN:?\s*/i, '');
        return {
          action: 'recover',
          failureKind: 'drift',
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
 * 创建 DefaultRunGuard
 */
export function createRunGuard(
  config?: RunGuardConfig,
  model?: ModelProvider,
): DefaultRunGuard {
  return new DefaultRunGuard(config, model);
}
