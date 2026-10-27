/**
 * Harness 层可靠性包装
 *
 * 包装 agentLoop()，注入所有可靠性行为：
 * - Planning-only 检测与重试
 * - 空响应重试
 * - 工具循环检测
 * - No-op 检测
 * - RunGuard 检查点
 * - SecurityGuard 安全检查（通过 beforeToolCall 注入）
 * - ErrorStrategy 重试策略（通过 onError 注入）
 *
 * 设计原则：
 * - 使用 onTurnComplete 做副作用（注入 steer 指令），不直接控制停止
 * - 使用 shouldStopAfterTurn 做停止决策（critical 循环、RunGuard）
 * - 两层分离，不互相覆盖
 */

import type { Message, ToolCall } from '@octopi-agent/core/types.js';
import { getTextContent } from '@octopi-agent/core/types.js';
import type {
  AgentContext,
  AgentLoopConfig,
  AgentLoopEvent,
  ClassifiedError,
  LoopToolResult,
  TurnContext,
} from '@octopi-agent/core/loop/types.js';
import type { HarnessLoopEvent, PolicyUnit } from './harness-events.js';
import { classifyError } from '@octopi-agent/core/loop/error-classifier.js';
import { agentLoop } from '@octopi-agent/core/loop/agent-loop.js';
import { maxAttemptsFor } from './model-error-policy.js';
import type {
  ToolCallRecord,
  ToolLoopDetectionConfig,
} from '../concurrency/tool-loop-detection.js';
import {
  recordToolCall,
  detectNoProgressLoop,
  hashToolCall,
} from '../concurrency/tool-loop-detection.js';
import type { SecurityGuard } from '@octopi-agent/core/security-guard.js';
import { severityToAction } from '@octopi-agent/core/security-guard.js';
import type { ErrorStrategy, ClassifiedError as CoreClassifiedError } from '@octopi-agent/core/interfaces/error-strategy.js';
import type { RunGuard, CheckpointContext, CheckpointVerdict, TurnSummary } from '@octopi-agent/core/interfaces/run-guard.js';
import type { ReliabilityHarness as CoreReliabilityHarness } from '@octopi-agent/core/interfaces/reliability.js';
import { RunMetricsCollector } from './run-metrics-collector.js';
import { BudgetPolicyEngine } from '../budget/budget.js';
import { UsageLedger } from '../../governance/accounting/usage-ledger.js';
import type { UsageLedgerSnapshot } from '../../governance/accounting/usage-ledger.js';
import { nominalTotalTokens } from '@octopi-agent/core/types/turn.js';
import { getRunScope } from '../run-scope.js';
import { resolveHitlDecision } from '../../governance/human-in-the-loop/decision-cache.js';

// ── 可靠性配置 ──

export interface ReliabilityConfig {
  /** Planning-only 重试 */
  planningRetry: {
    maxAttempts: number;
    steerInstruction: string;
  };
  /** 空响应重试 */
  emptyResponseRetry: {
    maxAttempts: number;
    steerInstruction: string;
  };
  /** No-op 检测阈值 */
  noopThreshold: number;
  /** 工具循环检测 */
  loopDetection: ToolLoopDetectionConfig;
  /** RunGuard 检查点初始间隔（默认 15；可被 verdict.nextCheckpointIn 覆盖） */
  checkpointInterval?: number;
  // ── P2 wrap-up 配置 ──
  /** wrap-up 相关配置 */
  wrapUp?: {
    /** wrap-up 窗口的轮次数（默认 3） */
    turns?: number;
    /** Policy 触达时的行为（默认 wrap_up_then_stop） */
    onPolicyHit?: 'stop' | 'wrap_up_then_stop';
    /** context 轴 wrap-up 触发阈值比例（默认 0.85） */
    contextRatio?: number;
  };
  // ── P3 Policy 单位配置 ──
  /** Policy 单位配置（仅显式配置才启用 hard） */
  policyUnits?: {
    /** 最大花费（币种由 pricing 决定） */
    maxCost?: number;
    /** 最大 uncached input tokens */
    maxUncachedInputTokens?: number;
    /** 最大 output tokens */
    maxOutputTokens?: number;
    /** 最大 LLM 调用次数 */
    maxLlmCalls?: number;
  };
  /** 模型定价（用于 USD 估算） */
  policyPricing?: Record<string, {
    inputPer1M: number;
    cachedInputPer1M?: number;
    outputPer1M: number;
  }>;
  /** Advisory 告警配置 */
  advisory?: {
    unit: 'wall_clock_ms' | 'cost' | 'uncached_input_tokens' | 'output_tokens' | 'llm_calls';
    threshold: number;
  };
}

export const DEFAULT_RELIABILITY_CONFIG: ReliabilityConfig = {
  planningRetry: {
    maxAttempts: 2,
    steerInstruction: 'Continue with the task using available tools.',
  },
  emptyResponseRetry: {
    maxAttempts: 2,
    steerInstruction: 'You have not provided a response. Please summarize your findings and respond to the user.',
  },
  noopThreshold: 3,
  loopDetection: {
    enabled: true,
    historySize: 30,
    warningThreshold: 10,
    criticalThreshold: 20,
    globalCircuitBreakerThreshold: 30,
  },
};

// ── Policy 辅助函数 ──

/**
 * 估算花费
 *
 * @param snapshot - UsageLedger 快照
 * @param pricing - 模型定价（按模型名查询，fallback 到 'default'）
 * @returns 估算的花费（币种由 pricing 决定）
 */
function estimateCost(
  snapshot: UsageLedgerSnapshot,
  pricing: Record<string, { inputPer1M: number; cachedInputPer1M?: number; outputPer1M: number }>,
): number {
  // 默认定价（如果未配置 'default' key）
  const defaultPricing = pricing['default'] ?? { inputPer1M: 3, outputPer1M: 15 };

  const inputCost = (snapshot.inputUncachedTokens / 1_000_000) * defaultPricing.inputPer1M;
  const cachedCost = snapshot.cacheAware && defaultPricing.cachedInputPer1M
    ? (snapshot.inputCachedTokens / 1_000_000) * defaultPricing.cachedInputPer1M
    : 0;
  const outputCost = (snapshot.outputTokens / 1_000_000) * defaultPricing.outputPer1M;

  return inputCost + cachedCost + outputCost;
}

// ── Harness 资源 ──

// Re-export core interface for backward compatibility
export type { CoreReliabilityHarness as ReliabilityHarness };

/**
 * 具体的可靠性装备（带类型化的 config）
 * 由 builder 构造，绑定到 harness Agent（`agent.setHarness`）；
 * 业务路径请用 `Agent.run()`，本函数是底层包装。
 */
export interface ConcreteReliabilityHarness extends CoreReliabilityHarness {
  config: ReliabilityConfig;
}

// ── 运行时状态 ──

interface ReliabilityState {
  planningOnlyAttempts: number;
  planningOnlySteerInjected: boolean;
  emptyResponseAttempts: number;
  emptyResponseSteerInjected: boolean;
  consecutiveNoops: number;
  toolCallHistory: ToolCallRecord[];
  loopCriticalTriggered: boolean;
  collector: RunMetricsCollector;
  checkpointIterationCount: number;
  currentCheckpointInterval: number;
  lastCheckpointIteration: number;
  budgetStop: false | { reason: string; report?: unknown };
  runGuardStop: false | { reason: string; userMessage?: string };
  runGuardRecovered: false | { reason: string; actions: string[] };
  hasProgress: boolean;
  forceCheckpoint: boolean;
  /** 连续模型错误的 attempt 序号（从 0 起）；成功一轮后重置 */
  modelErrorAttempt: number;
  /** hard 在 onTurnComplete 补判：generator 下一事件后 yield */
  pendingBudgetHardYield: false | {
    reason: 'wall_clock' | 'iteration' | 'tool_calls';
    report?: unknown;
  };
  /** SecurityGuard 拦截：在 generator 主循环 yield（beforeToolCall 不能 yield） */
  pendingSecurityEvents: Array<{
    type: 'security_blocked';
    timestamp: number;
    data: Record<string, unknown>;
  }>;
  /**
   * 模型调用重试通知：onError 不是 generator，无法直接 yield，
   * 与 SecurityGuard 同策略入队，由主循环在下一个事件边界推出（onError 之后
   * agentLoop 立即产出 turn_end，故通知紧随重试决策抵达消费方）。
   */
  /** 待执行的模型重试退避等待（毫秒）；在通知 yield 之后消费，保证「通知先于等待」 */
  pendingRetryDelayMs: number;
  pendingModelRetryEvents: Array<{
    type: 'model_retry';
    timestamp: number;
    data: {
      attempt: number;
      maxAttempts: number;
      reason: string;
      delayMs: number;
      error: string;
    };
  }>;
  // ── P2 wrap-up 控制梯 ──
  /** wrap-up 状态：false 表示未进入 wrap-up */
  wrapUp: false | {
    reason: 'context' | 'policy';
    turnsRemaining: number;
    /** 进入 wrap-up 时的用户消息 */
    userMessage: string;
    /** 是否已注入 wrap-up 提示 */
    hintInjected: boolean;
  };
  // ── P3 advisory 告警 ──
  /** 已触发的 advisory（避免重复告警） */
  advisoryTriggered: Set<string>;
}

/**
 * 入队一条「模型调用即将重试」通知
 *
 * onError 不是 generator，无法直接 yield；与 SecurityGuard 同策略入队，
 * 由主循环在下一个事件边界推出。
 *
 * @param state - Run 状态（承载待推队列）
 * @param error - 分类后的错误
 * @param attempt - 本次尝试序号（从 0 起）
 * @param delayMs - 重试前等待时长
 */
/**
 * 入队一条「模型调用即将重试」通知，并登记待执行的退避等待
 *
 * onError 不是 generator，无法直接 yield；与 SecurityGuard 同策略入队，
 * 由主循环在下一个事件边界推出。
 *
 * **等待不在这里执行**（2026-10-27 评审修正）：若在此 `await sleep(delayMs)`，
 * generator 会卡在 onError 内，外层 for-await 没有任何事件可排空，
 * 通知要等睡眠结束才送达——`rate_limit` 带 `Retry-After` 时用户在整个等待期仍是零反馈。
 * 因此把退避时长登记到 state，由排空处在 `yield` 之后再 sleep。
 *
 * @param state - reliability 运行态
 * @param error - 已分类错误
 * @param attempt - 本次尝试序号（从 0 起）
 * @param delayMs - 重试前需等待的时长
 * @param maxAttempts - 该原因的允许重试次数（由调用方给出，避免表外原因显示 0）
 */
function pushRetryNotice(
  state: ReliabilityState,
  error: ClassifiedError,
  attempt: number,
  delayMs: number,
  maxAttempts: number,
): void {
  state.pendingModelRetryEvents.push({
    type: 'model_retry',
    timestamp: Date.now(),
    data: {
      attempt: attempt + 1,
      maxAttempts,
      reason: error.reason,
      delayMs,
      error: (error.message || '').slice(0, 500),
    },
  });
  // 多条通知合并成一次等待：取最大退避，避免退避时长被叠加放大
  state.pendingRetryDelayMs = Math.max(state.pendingRetryDelayMs, delayMs);
}

/**
 * 可被 abort 打断的等待
 *
 * `rate_limit` 的 `Retry-After` 可达数十秒；若用裸 `setTimeout`，
 * 用户按下停止后仍要等满整个退避窗口才能生效。
 *
 * @param ms - 等待时长
 * @param signal - 运行中止信号（可选）
 * @returns 到时或被中止时 resolve（不 reject：中止由循环自身处理）
 */
async function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function createInitialState(checkpointInterval = 15): ReliabilityState {
  return {
    planningOnlyAttempts: 0,
    planningOnlySteerInjected: false,
    emptyResponseAttempts: 0,
    emptyResponseSteerInjected: false,
    consecutiveNoops: 0,
    toolCallHistory: [],
    loopCriticalTriggered: false,
    collector: new RunMetricsCollector(),
    checkpointIterationCount: 0,
    currentCheckpointInterval: checkpointInterval,
    lastCheckpointIteration: 0,
    budgetStop: false,
    runGuardStop: false,
    runGuardRecovered: false,
    hasProgress: true,
    forceCheckpoint: false,
    modelErrorAttempt: 0,
    pendingBudgetHardYield: false,
    pendingSecurityEvents: [],
    pendingRetryDelayMs: 0,
    pendingModelRetryEvents: [],
    wrapUp: false,
    advisoryTriggered: new Set(),
  };
}

// ── Planning-only 检测（从 engine.ts 提取） ──

const PLANNING_ONLY_PROMISE_RE = /\b(?:i(?:'ll| will)|let me|i(?:'m| am)\s+going to|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|i can do that)\b/i;
const PLANNING_ONLY_COMPLETION_RE = /\b(?:done|finished|implemented|updated|fixed|changed|ran|verified|found|here(?:'s| is) what|blocked by|the blocker is)\b/i;
const PLANNING_ONLY_HEADING_RE = /^(?:plan|steps?|next steps?)\s*:/i;
const PLANNING_ONLY_BULLET_RE = /^(?:[-*•]\s+|\d+[.)]\s+)/u;
const PLANNING_ONLY_MAX_VISIBLE_TEXT = 700;
const PLANNING_ONLY_ACTION_VERB_RE = /\b(?:inspect|investigate|check|look(?:\s+into|\s+at)?|read|search|find|debug|fix|patch|update|change|edit|write|implement|run|test|verify|review|analy(?:s|z)e|summari(?:s|z)e|explain|answer|show|share|report|prepare|capture|take|refactor|restart|deploy|ship)\b/i;
const PLANNING_ONLY_PROMISE_ZH_RE = /(?:我会|让我|接下来我|我将|我需要|首先我|下一步我)/;
const PLANNING_ONLY_ACTION_VERB_ZH_RE = /(?:查看|分析|检查|读取|列出|搜索|研究|执行|运行|测试|验证|审查|总结|解释|回答|展示|分享|报告|准备|捕获|获取|重构|重启|部署)/;
const PLANNING_ONLY_COMPLETION_ZH_RE = /(?:完成|已完成|已实现|已更新|已修复|已更改|已运行|已验证|已找到|以下是|结果是|被阻塞|阻塞原因)/;

function isPlanningOnlyResponse(content: string, hasToolCalls: boolean): boolean {
  if (!content || content.trim().length === 0) return false;
  if (hasToolCalls) return false;

  const text = content.trim();
  if (text.length < 20) return false;
  if (text.length > PLANNING_ONLY_MAX_VISIBLE_TEXT) return false;
  if (text.includes('```')) return false;

  const hasStructuredFormat = hasStructuredPlanningOnlyFormat(text);
  const hasPromise = PLANNING_ONLY_PROMISE_RE.test(text) || PLANNING_ONLY_PROMISE_ZH_RE.test(text);
  if (!hasPromise && !hasStructuredFormat) return false;

  if (!hasStructuredFormat) {
    const hasActionVerb = PLANNING_ONLY_ACTION_VERB_RE.test(text) || PLANNING_ONLY_ACTION_VERB_ZH_RE.test(text);
    if (!hasActionVerb) return false;
  }

  const isCompletion = PLANNING_ONLY_COMPLETION_RE.test(text) || PLANNING_ONLY_COMPLETION_ZH_RE.test(text);
  if (isCompletion) return false;

  return true;
}

function hasStructuredPlanningOnlyFormat(text: string): boolean {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return false;

  const bulletLineCount = lines.filter(line => PLANNING_ONLY_BULLET_RE.test(line)).length;
  const hasPlanningCueLine = lines.some(line =>
    PLANNING_ONLY_PROMISE_RE.test(line) || PLANNING_ONLY_PROMISE_ZH_RE.test(line),
  );

  return (PLANNING_ONLY_HEADING_RE.test(lines[0] ?? '') && hasPlanningCueLine) ||
         (bulletLineCount >= 2 && hasPlanningCueLine);
}

// ── high 风险确认 ──

/**
 * high 风险人工确认（SEC-7 单模型）
 *
 * - 有 `harness.confirmHighRisk`：查 HitlDecisionCache → 调钩子（返回 HitlDecision）
 * - 无审批通道 / 异常 / deny：回退 reject（false），无人值守不放行
 * - `approve_session` / `approve_always` 由引擎缓存，同 session/进程免再问
 */
async function confirmHighRiskDecision(
  harness: CoreReliabilityHarness,
  toolCall: ToolCall,
  reason: string,
  severity: string,
): Promise<boolean> {
  const confirm = harness.confirmHighRisk;
  if (!confirm) return false;
  const scope = getRunScope();
  return resolveHitlDecision({
    channel: 'high_risk',
    key: toolCall.name,
    sessionId: scope?.sessionId,
    agentId: scope?.agentId,
    ask: async () =>
      await confirm({
        toolCall,
        reason,
        severity,
        sessionId: scope?.sessionId,
        agentId: scope?.agentId,
      }),
  });
}

// ── 核心包装函数 ──

/**
 * 带可靠性的 Agent 循环
 *
 * 包装 agentLoop()，注入所有可靠性行为。
 */
export async function* runAgentWithReliability(
  context: AgentContext,
  config: AgentLoopConfig,
  harness: CoreReliabilityHarness,
  signal?: AbortSignal,
): AsyncGenerator<HarnessLoopEvent> {
  const state = createInitialState(
    (harness.config as ReliabilityConfig | undefined)?.checkpointInterval ?? 15,
  );
  const relConfig = { ...DEFAULT_RELIABILITY_CONFIG, ...(harness.config as ReliabilityConfig | undefined) };

  // per-run Budget：从 harness 模板克隆，避免长驻进程 / 并发 session 共享计数
  let budget = harness.budget;
  if (budget) {
    budget = new BudgetPolicyEngine(
      budget.getConfig() as import('../budget/budget.js').BudgetPolicyConfig,
    );
  }
  /** P1：run 级用量账本（只记账，不 kill） */
  const ledger = new UsageLedger();

  // ── 用于空响应/planning-only 重试的消息缓冲 ──
  // onTurnComplete 将 steer 消息推入此数组，getFollowUpMessages 返回给 agentLoop
  // 使循环在无 tool_calls 时也能继续执行重试
  const pendingFollowUps: Message[] = [];

  // ── 注入安全检查到 beforeToolCall ──
  const originalBeforeToolCall = config.beforeToolCall;
  const wrappedConfig: AgentLoopConfig = {
    ...config,

    // getFollowUpMessages：返回 reliability 层注入的 steer 消息
    getFollowUpMessages: async () => {
      const msgs = [...pendingFollowUps];
      pendingFollowUps.length = 0;
      if (config.getFollowUpMessages) {
        const callerMsgs = await config.getFollowUpMessages();
        msgs.push(...callerMsgs);
      }
      return msgs;
    },

    // beforeToolCall：Budget hard 闸 + wrap-up 控制 + SecurityGuard 检查 + 原始回调
    beforeToolCall: async (ctx, signal) => {
      // ops P5 kill switch：宿主侧急停，先于一切执行（不依赖 LLM/agent 合作，agent 无法解除）
      {
        const scope = getRunScope();
        const killPaths = scope?.toolRuntime?.killSwitchPaths;
        if (killPaths && killPaths.length > 0) {
          const { checkKillSwitch } = await import(
            '../../extension/execution-environment/kill-switch.js'
          );
          const killState = checkKillSwitch(killPaths);
          if (killState.engaged) {
            const reason = `kill_switch_active: agent execution is halted by the host sentinel (${killState.path})`;
            state.pendingSecurityEvents.push({
              type: 'security_blocked',
              timestamp: Date.now(),
              data: {
                sessionId: scope?.sessionId,
                agentId: scope?.agentId,
                reason,
                toolName: ctx.toolCall.name,
                action: 'reject',
                severity: 'high',
                violations: [
                  {
                    type: 'unauthorized_tool',
                    severity: 'high',
                    description: reason,
                  },
                ],
              },
            });
            return { block: true, reason, terminate: true };
          }
        }
      }
      // Budget hard：阻止本批工具继续执行（turn_end 在工具之前 yield）
      if (budget && !state.budgetStop) {
        const hard = budget.checkHardOnly();
        if (hard.status === 'hard') {
          state.budgetStop = {
            reason: hard.reason ?? 'wall_clock',
            report: hard.report,
          };
          state.pendingBudgetHardYield = {
            reason: (hard.reason ?? 'wall_clock') as
              | 'wall_clock'
              | 'iteration'
              | 'tool_calls',
            report: hard.report,
          };
        }
      }
      if (state.budgetStop) {
        return {
          block: true,
          reason: `Budget exceeded (${typeof state.budgetStop === 'object' ? state.budgetStop.reason : 'wall_clock'})`,
          terminate: true,
        };
      }

      // P2 wrap-up：在 wrap-up 窗口内注入提示，阻止探索性工具调用
      if (state.wrapUp) {
        // 注入 wrap-up 提示（仅一次）
        if (!state.wrapUp.hintInjected) {
          state.wrapUp.hintInjected = true;
          // 通过 getFollowUpMessages 注入提示
          pendingFollowUps.push({
            role: 'user',
            content: state.wrapUp.userMessage,
            timestamp: Date.now(),
            metadata: { source: 'engineHint' },
          });
        }
        // wrap-up 窗口内：允许只读工具，阻止写入工具
        // 简化实现：允许所有工具，让模型自行决策
        // 完整实现应检查工具类型（只读 vs 写入）
      }
      // Tool surface (untrusted degrade): strip egress/exec tools
      if (harness.toolSurface === 'reduced') {
        const { isToolAllowedOnSurface } = await import(
          '../../extension/execution-environment/effect-policy.js'
        );
        if (!isToolAllowedOnSurface(ctx.toolCall.name, 'reduced')) {
          const scope = getRunScope();
          const reason = `tool_surface_reduced: "${ctx.toolCall.name}" is not allowed when untrusted is degraded`;
          state.pendingSecurityEvents.push({
            type: 'security_blocked',
            timestamp: Date.now(),
            data: {
              sessionId: scope?.sessionId,
              agentId: scope?.agentId,
              reason,
              toolName: ctx.toolCall.name,
              action: 'reject',
              severity: 'high',
              violations: [
                {
                  type: 'unauthorized_tool',
                  severity: 'high',
                  description: reason,
                },
              ],
            },
          });
          return { block: true, reason, terminate: false };
        }
      }
      // SEC-2: session toolRights ∩ agent ToolPolicy (narrow-only, deny wins).
      // Read from RunScope (per-run); harness is shared across concurrent sessions.
      {
        const scope = getRunScope();
        const sessionRights = scope?.toolRuntime?.sessionToolRights;
        const agentPolicy = scope?.toolRuntime?.agentToolPolicy;
        if (sessionRights || agentPolicy) {
          const { isToolPermitted } = await import(
            '../../governance/session-acl/tool-rights.js'
          );
          if (
            !isToolPermitted(ctx.toolCall.name, undefined, [
              agentPolicy,
              sessionRights,
            ])
          ) {
            const reason = `tool_rights_denied: "${ctx.toolCall.name}" is not permitted for this session participant`;
            // ops P5/§8.6：提权请求者缺权 → **确认闸门之前**拒绝并留痕（not_authorized，
            // 无弹窗）。工具 handler 根本不会执行——确认 ≠ 请求者可信。
            if (ctx.toolCall.name === 'priv_exec') {
              scope?.toolRuntime?.recordOpsEvent?.({
                event: 'ops.escalation.denied',
                data: {
                  argv: [
                    String((ctx.toolCall.arguments as { cmd?: unknown } | undefined)?.cmd ?? ''),
                    ...(((ctx.toolCall.arguments as { args?: unknown } | undefined)?.args as string[] | undefined) ?? []),
                  ],
                  why: 'not_authorized',
                  toolName: ctx.toolCall.name,
                  origin: {
                    sessionId: scope?.sessionId,
                    agentId: scope?.agentId,
                    runId: scope?.runId ?? null,
                    participants: scope?.toolRuntime?.sessionParticipants ?? [],
                  },
                },
              });
            }
            state.pendingSecurityEvents.push({
              type: 'security_blocked',
              timestamp: Date.now(),
              data: {
                sessionId: scope?.sessionId,
                agentId: scope?.agentId,
                reason,
                toolName: ctx.toolCall.name,
                action: 'reject',
                severity: 'high',
                violations: [
                  {
                    type: 'unauthorized_tool',
                    severity: 'high',
                    description: reason,
                  },
                ],
              },
            });
            return { block: true, reason, terminate: false };
          }
        }
      }
      if (harness.security) {
        const toolCheck = harness.security.checkToolCall(ctx.toolCall);
        if (!toolCheck.isClean) {
          const worst = toolCheck.violations.reduce((worst, v) => {
            const order = { critical: 4, high: 3, medium: 2, low: 1 };
            return order[v.severity] > order[worst.severity] ? v : worst;
          }, toolCheck.violations[0]);
          const action = severityToAction(worst.severity);
          if (action === 'block' || action === 'reject' || action === 'confirm') {
            // high：优先走人工确认；无审批通道或用户拒绝时回退 reject
            if (action === 'confirm') {
              const confirmed = await confirmHighRiskDecision(
                harness,
                ctx.toolCall,
                worst.description,
                worst.severity,
              );
              if (confirmed) {
                // 确认放行：继续原始 beforeToolCall
                if (originalBeforeToolCall) {
                  return originalBeforeToolCall(ctx, signal);
                }
                return undefined;
              }
            }
            const scope = getRunScope();
            state.pendingSecurityEvents.push({
              type: 'security_blocked',
              timestamp: Date.now(),
              data: {
                sessionId: scope?.sessionId,
                agentId: scope?.agentId,
                reason: worst.description,
                toolName: ctx.toolCall.name,
                action: action === 'confirm' ? 'reject' : action,
                severity: worst.severity,
                violations: toolCheck.violations.map((v) => ({
                  type: v.type,
                  severity: v.severity,
                  description: v.description,
                })),
              },
            });
            return {
              block: true,
              reason: worst.description,
              terminate: action === 'block',
            };
          }
        }
      }
      // 原始 beforeToolCall
      if (originalBeforeToolCall) {
        return originalBeforeToolCall(ctx, signal);
      }
      return undefined;
    },

    // afterToolCall：SecurityGuard 输出检查 + no-op 检测 + 原始回调
    afterToolCall: async (ctx, signal) => {
      // SecurityGuard 检查工具输出（字符串直扫；结构化结果序列化后扫，防 MCP/对象结果绕过）
      if (harness.security && ctx.result.content != null) {
        const raw = ctx.result.content;
        const scanText =
          typeof raw === 'string'
            ? raw
            : (() => {
                try {
                  return JSON.stringify(raw);
                } catch {
                  return String(raw);
                }
              })();
        // 超大 payload 截断扫描，避免序列化字符串拖垮 checkToolOutput
        const outputCheck = harness.security.checkToolOutput(
          scanText.length > 100_000 ? scanText.slice(0, 100_000) : scanText,
        );
        if (!outputCheck.isClean) {
          const action = severityToAction(
            outputCheck.violations.reduce((worst, v) => {
              const order = { critical: 4, high: 3, medium: 2, low: 1 };
              return order[v.severity] > order[worst.severity] ? v : worst;
            }, outputCheck.violations[0]).severity,
          );
          // 输出侧无「事前确认」语义：confirm/high 一律拦截该输出
          if (action === 'block' || action === 'reject' || action === 'confirm') {
            const reason = outputCheck.violations
              .map((v) => v.description)
              .filter(Boolean)
              .join('; ');
            return {
              content: reason
                ? `Blocked by SecurityGuard: ${reason}`
                : 'Blocked by SecurityGuard: policy violation',
              isError: true,
            };
          }
        }
      }
      // 原始 afterToolCall
      if (config.afterToolCall) {
        return config.afterToolCall(ctx, signal);
      }
      return undefined;
    },

    // onTurnComplete：可靠性副作用（注入 steer 指令，不控制停止）
    onTurnComplete: async (ctx) => {
      // 一轮成功走到这里：重置模型错误 attempt
      state.modelErrorAttempt = 0;

      const hasToolCalls = ctx.toolResults.length > 0;
      const contentText = getTextContent(ctx.message.content);
      const hasContent = contentText.trim().length > 0;
      const hasToolCallInMessage = ctx.message.toolCalls && ctx.message.toolCalls.length > 0;

      // 0. 记录本轮摘要（token 在 generator 层从 turn_end.usage 累加）
      const summary: TurnSummary = {
        role: 'assistant',
        contentPreview: contentText.slice(0, 200),
        toolCalls: ctx.message.toolCalls?.map(t => t.name),
        toolErrors: ctx.toolResults.filter(r => r.isError).map(r => r.name),
        tokenDelta: 0,
        timestamp: Date.now(),
      };
      state.collector.recordTurn(summary);
      state.hasProgress = state.collector.hasProgress();

      // 0b. Budget hard（P0：无 soft 续租；nominal tokens 仅诊断）
      if (budget && !state.budgetStop) {
        const hardEval = budget.checkHardOnly();
        if (hardEval.status === 'hard') {
          state.budgetStop = {
            reason: hardEval.reason ?? 'wall_clock',
            report: hardEval.report,
          };
          state.pendingBudgetHardYield = {
            reason: (hardEval.reason ?? 'wall_clock') as
              | 'wall_clock'
              | 'iteration'
              | 'tool_calls',
            report: hardEval.report,
          };
        }
      }

      // 1. Planning-only 检测
      if (!hasToolCalls && isPlanningOnlyResponse(contentText, !!hasToolCallInMessage)) {
        if (state.planningOnlyAttempts < relConfig.planningRetry.maxAttempts) {
          state.planningOnlyAttempts++;
          if (!state.planningOnlySteerInjected) {
            pendingFollowUps.push({
              role: 'user',
              content: `[System: ${relConfig.planningRetry.steerInstruction}]`,
              timestamp: Date.now(),
              metadata: { source: 'engineHint' },
            });
            state.planningOnlySteerInjected = true;
          }
        }
      } else {
        state.planningOnlyAttempts = 0;
        state.planningOnlySteerInjected = false;
      }

      // 2. 空响应检测
      if (!hasToolCalls && (!hasContent || contentText.trim().length === 0)) {
        if (state.emptyResponseAttempts < relConfig.emptyResponseRetry.maxAttempts) {
          state.emptyResponseAttempts++;
          if (!state.emptyResponseSteerInjected) {
            pendingFollowUps.push({
              role: 'user',
              content: `[System: ${relConfig.emptyResponseRetry.steerInstruction}]`,
              timestamp: Date.now(),
              metadata: { source: 'engineHint' },
            });
            state.emptyResponseSteerInjected = true;
          }
        }
      } else {
        state.emptyResponseAttempts = 0;
        state.emptyResponseSteerInjected = false;
      }

      // 3. No-op 检测
      const noopCount = ctx.toolResults.filter(r => r.noop).length;
      if (noopCount > 0) {
        state.consecutiveNoops += noopCount;
        if (state.consecutiveNoops >= relConfig.noopThreshold) {
          // 第一次达到阈值：注入 hint
          if (state.consecutiveNoops === relConfig.noopThreshold) {
            ctx.context.messages.push({
              role: 'user',
              content: '[System: Multiple tool calls produced no result. Please try a different approach.]',
              timestamp: Date.now(),
              metadata: { source: 'engineHint' },
            });
          } else {
            // 超过阈值：标记停止 + 立即检查点
            (state as any)._noopLoopStop = true;
            state.forceCheckpoint = true;
            // 停止必须可见：只置标志不发声时，用户看到的就是「跑着跑着没了」
            state.runGuardStop = {
              reason: `连续 ${state.consecutiveNoops} 次工具调用无任何返回（no-op 循环）`,
              userMessage: `连续 ${state.consecutiveNoops} 次工具调用没有任何结果，判定为无效循环，本轮已停止。请换个做法或说明当前阻塞点。`,
            };
            state.collector.noteExternalSignal({
              source: 'noop',
              level: 'critical',
              detail: `连续 ${state.consecutiveNoops} 次 noop`,
              timestamp: Date.now(),
            });
          }
        }
      } else {
        state.consecutiveNoops = 0;
      }

      // 4. 工具循环检测
      const loopDetectionEnabled = relConfig.loopDetection.enabled !== false;

      // 4a. 指标记录与 loopDetection 开关解耦：RunGuard 的 repeated/identical 判据
      //     不能因为关掉 loopDetection 就永远为 0（否则 Guard 静默失效）。
      for (const result of ctx.toolResults) {
        const tc = ctx.message.toolCalls?.find(t => t.id === result.toolCallId);
        state.collector.recordToolResult(result.name, !result.isError, !!result.noop, {
          // 与旁路 loop 检测器同口径：arguments 缺失时归一为 {}
          args: tc?.arguments ?? {},
          result: result.isError ? undefined : result.content,
          error: result.isError ? result.content : undefined,
        });
      }

      if (hasToolCalls && loopDetectionEnabled) {
        // 记录工具调用
        for (const result of ctx.toolResults) {
          // 从 message.toolCalls 中找到对应的 toolCall
          const tc = ctx.message.toolCalls?.find(t => t.id === result.toolCallId);
          state.toolCallHistory = recordToolCall(
            state.toolCallHistory,
            result.name,
            tc?.arguments ?? {},
            result.isError ? null : result.content,
            result.isError ? result.content : undefined,
            { enabled: true, ...relConfig.loopDetection },
          );
        }

        // 检测循环
        const firstResult = ctx.toolResults[0];
        if (firstResult) {
          const tc = ctx.message.toolCalls?.find(t => t.id === firstResult.toolCallId);
          const loopResult = detectNoProgressLoop(
            state.toolCallHistory,
            firstResult.name,
            tc?.arguments ?? {},
            { enabled: true, ...relConfig.loopDetection },
          );

          if (loopResult.stuck) {
            state.collector.noteExternalSignal({
              source: 'tool_loop',
              level: loopResult.level,
              detail: loopResult.message,
              timestamp: Date.now(),
            });
            if (loopResult.level === 'critical') {
              // 高危信号：立即触发检查点（不等固定 interval）
              state.forceCheckpoint = true;
              if (state.loopCriticalTriggered) {
                // 二次 critical：通过 shouldStopAfterTurn 停止
                (state as any)._loopCriticalTwice = true;
                // 停止必须可见：与 RunGuard 走同一事件通道
                state.runGuardStop = {
                  reason: `连续两轮检测到高危循环信号：${loopResult.message}`,
                  userMessage: '检测到重复的高危循环迹象，本轮已停止。请换个做法或说明当前阻塞点。',
                };
              } else {
                state.loopCriticalTriggered = true;
                ctx.context.messages.push({
                  role: 'user',
                  content: `[System: ${loopResult.message} Stop calling tools and provide your final response based on the information gathered so far.]`,
                  timestamp: Date.now(),
                  metadata: { source: 'engineHint' },
                });
              }
            } else if (loopResult.level === 'warning') {
              ctx.context.messages.push({
                role: 'user',
                content: `[System: ${loopResult.message}]`,
                timestamp: Date.now(),
                metadata: { source: 'engineHint' },
              });
            }
          }
        }
      }

      // 5. RunGuard 检查点（周期 + 高危即时）
      if (harness.runGuard) {
        state.checkpointIterationCount++;
        const due =
          state.forceCheckpoint ||
          state.checkpointIterationCount >= state.currentCheckpointInterval;
        if (due) {
          state.checkpointIterationCount = 0;
          state.forceCheckpoint = false;
          try {
            // I1：checkpoint 身份优先 RunScope ALS（harness.sessionId 仅为回退）
            const scope = getRunScope();
            const ctxForGuard = state.collector.buildContext({
              sessionId: scope?.sessionId ?? harness.sessionId,
              agentId: scope?.agentId ?? harness.agentId,
            });
            const verdict = await harness.runGuard.checkpoint(ctxForGuard);
            if (verdict.action === 'stop') {
              state.runGuardStop = {
                reason: verdict.reason,
                userMessage: verdict.userMessage,
              };
            } else if (verdict.action === 'recover') {
              // 一次 checkpoint 只记 1 条 recovery（避免多 action 放大升级计数）
              const primary =
                verdict.recoveryActions?.[0]?.type ?? 'inject_hint';
              if (verdict.recoveryActions?.length) {
                executeRecoveryActions(verdict.recoveryActions, ctx.context.messages);
              }
              state.collector.recordRecovery({
                iteration: ctxForGuard.iteration,
                actionType: primary,
                reason: verdict.reason,
                failureKind: verdict.failureKind,
                timestamp: Date.now(),
              });
              state.runGuardRecovered = {
                reason: verdict.reason,
                actions: (verdict.recoveryActions ?? []).map(a => a.type),
              };
            }
            if (verdict.nextCheckpointIn && verdict.nextCheckpointIn > 0) {
              state.currentCheckpointInterval = verdict.nextCheckpointIn;
            }
            state.lastCheckpointIteration = ctxForGuard.iteration;
            // 检查点后清空已消费的 external signals
            state.collector.drainExternalSignals();
          } catch {
            // 监督节点出错不影响主循环
          }
        }
      } else {
        state.checkpointIterationCount++;
      }

      // 调用用户的 onTurnComplete（如果有）
      if (config.onTurnComplete) {
        await config.onTurnComplete(ctx);
      }
    },

    // shouldStopAfterTurn：停止决策
    shouldStopAfterTurn: async (ctx) => {
      // 0. Budget hard
      if (state.budgetStop) {
        return true;
      }
      // 1. 二次循环 critical → 停止
      if ((state as any)._loopCriticalTwice) {
        return true;
      }
      // 2. RunGuard 要求停止
      if (state.runGuardStop) {
        return true;
      }
      // 3. No-op 循环超限 → 停止
      if ((state as any)._noopLoopStop) {
        return true;
      }
      // 4. 用户的停止条件
      if (config.shouldStopAfterTurn) {
        return config.shouldStopAfterTurn(ctx);
      }
      return false;
    },

    // onError：错误分类 + ErrorStrategy
    // Loop 契约：只允许 'retry' | 'abort'；业务错误永不 throw
    onError: async (error) => {
      const classified = classifyError(error);
      const attempt = state.modelErrorAttempt;
      state.modelErrorAttempt++;

      // ErrorStrategy 决策（attempt 从 0 起，与 DefaultErrorStrategy 的 attempt < N 对齐）
      // skip 在 Loop 层无对应动作，映射为 abort；模型灾备用 FallbackProvider，不在此切换
      if (harness.errorStrategy) {
        const action = harness.errorStrategy.onModelError(classified, attempt);
        if (action.action === 'retry') {
          const delayMs = action.delayMs ?? 0;
          // maxAttempts 取「本次实际允许的重试次数」；自定义 strategy 对表外原因也重试时，
          // 至少报 1（而不是 0），避免 UI 显示「第 1 次 / 共 0 次」
          pushRetryNotice(state, classified, attempt, delayMs, Math.max(1, maxAttemptsFor(classified.reason)));
          return 'retry';
        }
        return 'abort';
      }

      // 默认：按错误原因分级重试（次数上限见 MODEL_ERROR_MAX_ATTEMPTS）
      // network 含对端断连（undici terminated / socket hang up），重试常可自愈；
      // timeout 只给 1 次——一次失败已经耗掉整个 watchdog 窗口（流 300s + 同步兜底 300s），
      // 原样再来 3 轮正是 2026-10-27 那次 52 分钟黑屏的成因。
      const maxAttempts = maxAttemptsFor(classified.reason);
      if (attempt < maxAttempts) {
        const delayMs = classified.retryAfterMs ?? (attempt + 1) * 1000;
        pushRetryNotice(state, classified, attempt, delayMs, maxAttempts);
        return 'retry';
      }
      return 'abort';
    },
  };

  // 运行核心循环：拦截事件以计量 token / 注入 budget & run_guard 用户可见事件（不变量 #6）
  for await (const event of agentLoop(context, wrappedConfig, signal)) {
    // SecurityGuard 拦截（beforeToolCall 推入 pending，此处 yield）
    while (state.pendingSecurityEvents.length > 0) {
      const sec = state.pendingSecurityEvents.shift()!;
      yield sec as never;
    }
    // 模型重试通知（onError 入队，此处推出：重试窗口必须对用户可见）
    while (state.pendingModelRetryEvents.length > 0) {
      const retry = state.pendingModelRetryEvents.shift()!;
      yield retry as never;
    }
    // 退避等待放在通知 yield 之后：消费方已看到「即将重试 + 等多久」，
    // 而 agentLoop 此刻挂在 turn_end 之后未继续，下一次调用不会提前发起。
    if (state.pendingRetryDelayMs > 0) {
      const waitMs = state.pendingRetryDelayMs;
      state.pendingRetryDelayMs = 0;
      await sleepUnlessAborted(waitMs, signal);
    }
    // Observer：run 结束前附带 RunMetricsCollector 快照（P1 Guard 面板）
    if (event.type === 'agent_end') {
      const scope = getRunScope();
      const runSnapshot = ledger.snapshot({
        scope: 'run',
        sessionId: scope?.sessionId,
        agentId: scope?.agentId,
      });

      // P4: 合并 run 级快照到 session 级账本
      const sessionLedger = harness.sessionLedger as import('../../governance/accounting/session-ledger.js').SessionLedger | undefined;
      if (sessionLedger) {
        sessionLedger.mergeRunSnapshot(runSnapshot);
      }

      yield {
        type: 'run_guard_metrics',
        timestamp: Date.now(),
        data: {
          ...state.collector.toObserverSnapshot({
            sessionId: scope?.sessionId,
            agentId: scope?.agentId,
          }),
          usageLedger: runSnapshot,
          sessionLedger: sessionLedger?.snapshot(),
        },
      };
    }
    if (event.type === 'tool_end') {
      // maxToolCalls 计量（显式配置时才硬停）
      budget?.recordToolCall(1);
      ledger.recordToolCall(1);
      // Summary LLM usage 归因（capabilities/summary 产生的 LLM 调用）
      const toolResult = event.result as { summaryUsage?: import('@octopi-agent/core/types/turn.js').TokenUsage };
      if (toolResult.summaryUsage) {
        ledger.recordUsage(toolResult.summaryUsage, { summary: true });
      }
    }

    if (event.type === 'turn_end') {
      // P0/P1：nominal tokens 入账诊断 + UsageLedger；不触发 spend hard
      if (event.usage && !event.error) {
        const nominal = nominalTotalTokens(event.usage);
        state.collector.recordTokens(nominal);
        budget?.consumeTokens(nominal);
        ledger.recordUsage(event.usage);
      }
      budget?.recordIteration();

      // P5: 更新 context 压力信息
      if (harness.getContextPressure) {
        const pressure = harness.getContextPressure();
        if (pressure) {
          ledger.updateContextPressure(pressure.estimatedTokens, pressure.contextWindow);
        }
      }

      // P3 Advisory 告警（接近阈值时告警，不终止）
      if (!state.budgetStop) {
        const advisory = relConfig.advisory;
        const snapshot = ledger.snapshot({ scope: 'run' });

        if (advisory && !state.advisoryTriggered.has(advisory.unit)) {
          let currentValue = 0;
          if (advisory.unit === 'wall_clock_ms' && budget) {
            currentValue = budget.report().elapsedMs;
          } else if (advisory.unit === 'uncached_input_tokens') {
            currentValue = snapshot.inputUncachedTokens;
          } else if (advisory.unit === 'output_tokens') {
            currentValue = snapshot.outputTokens;
          } else if (advisory.unit === 'llm_calls') {
            currentValue = snapshot.llmCalls;
          } else if (advisory.unit === 'cost' && relConfig.policyPricing) {
            currentValue = estimateCost(snapshot, relConfig.policyPricing);
          }

          if (currentValue >= advisory.threshold) {
            state.advisoryTriggered.add(advisory.unit);
            yield {
              type: 'usage.advisory',
              timestamp: Date.now(),
              metric: 'policy',
              unit: advisory.unit,
              used: currentValue,
              hard: advisory.threshold,
              userMessage: `[Advisory] ${advisory.unit} 接近阈值（${currentValue} / ${advisory.threshold}）`,
            };
          }
        }
      }

      // P3 Policy 单位评估
      if (!state.wrapUp && !state.budgetStop) {
        const policyUnits = relConfig.policyUnits;
        const snapshot = ledger.snapshot({ scope: 'run' });
        const onPolicyHit = relConfig.wrapUp?.onPolicyHit ?? 'wrap_up_then_stop';
        const wrapUpTurns = relConfig.wrapUp?.turns ?? 3;

        if (policyUnits) {
          // 检查所有 policy 单位，找到第一个超限的
          let exceededUnit: string | undefined;
          let exceededUsed = 0;
          let exceededHard = 0;

          if (policyUnits.maxUncachedInputTokens && snapshot.inputUncachedTokens >= policyUnits.maxUncachedInputTokens) {
            exceededUnit = 'uncached_input_tokens';
            exceededUsed = snapshot.inputUncachedTokens;
            exceededHard = policyUnits.maxUncachedInputTokens;
          } else if (policyUnits.maxOutputTokens && snapshot.outputTokens >= policyUnits.maxOutputTokens) {
            exceededUnit = 'output_tokens';
            exceededUsed = snapshot.outputTokens;
            exceededHard = policyUnits.maxOutputTokens;
          } else if (policyUnits.maxLlmCalls && snapshot.llmCalls >= policyUnits.maxLlmCalls) {
            exceededUnit = 'llm_calls';
            exceededUsed = snapshot.llmCalls;
            exceededHard = policyUnits.maxLlmCalls;
          } else if (policyUnits.maxCost && relConfig.policyPricing) {
            const estimatedCost = estimateCost(snapshot, relConfig.policyPricing);
            if (estimatedCost >= policyUnits.maxCost) {
              exceededUnit = 'cost';
              exceededUsed = estimatedCost;
              exceededHard = policyUnits.maxCost;
            }
          }

          // 根据 onPolicyHit 配置决定行为
          if (exceededUnit) {
            const userMessage = `[Resource] ${exceededUnit} 超限（${exceededUsed.toFixed?.(2) ?? exceededUsed} / ${exceededHard}）`;

            if (onPolicyHit === 'wrap_up_then_stop') {
              // 先 wrap-up，再 stop
              state.wrapUp = {
                reason: 'policy',
                turnsRemaining: wrapUpTurns,
                userMessage: `${userMessage}。停止新的探索性工具调用；基于已有信息输出结论、证据与未完成项。`,
                hintInjected: false,
              };
              yield {
                type: 'budget.wrap_up',
                timestamp: Date.now(),
                metric: 'policy',
                unit: exceededUnit as PolicyUnit,
                used: exceededUsed,
                hard: exceededHard,
                userMessage: state.wrapUp.userMessage,
                resumeHint: 'Run 已因 policy 超限进入 wrap-up 模式，请输出阶段性结论。',
              };
            } else {
              // 直接 stop
              state.budgetStop = {
                reason: 'policy',
                report: { unit: exceededUnit, used: exceededUsed, hard: exceededHard },
              };
              yield {
                type: 'budget.exceeded',
                timestamp: Date.now(),
                metric: 'policy',
                unit: exceededUnit as PolicyUnit,
                used: exceededUsed,
                hard: exceededHard,
                userMessage,
                resumeHint: `Run 已因 ${exceededUnit} 超限而停止。`,
              };
            }
          }
        }
      }

      // P2 wrap-up 控制梯：检查是否需要进入 wrap-up
      if (!state.wrapUp && !state.budgetStop) {
        const wrapUpConfig = relConfig.wrapUp;
        const wrapUpTurns = wrapUpConfig?.turns ?? 3;
        const contextRatio = wrapUpConfig?.contextRatio ?? 0.85;

        // 检查 context 轴 wrap-up（contextEstTokens / contextWindowTokens）
        const snapshot = ledger.snapshot({ scope: 'run' });
        if (snapshot.contextEstTokens && snapshot.contextWindowTokens) {
          const contextPressure = snapshot.contextEstTokens / snapshot.contextWindowTokens;
          if (contextPressure >= contextRatio) {
            state.wrapUp = {
              reason: 'context',
              turnsRemaining: wrapUpTurns,
              userMessage: `[Context] 上下文压力接近上限（${Math.round(contextPressure * 100)}%）。停止新的探索性工具调用；基于已有信息输出结论、证据与未完成项。`,
              hintInjected: false,
            };
            yield {
              type: 'budget.wrap_up',
              timestamp: Date.now(),
              metric: 'context',
              contextEst: snapshot.contextEstTokens,
              contextWindow: snapshot.contextWindowTokens,
              userMessage: state.wrapUp.userMessage,
              resumeHint: 'Run 已因 context 压力进入 wrap-up 模式，请输出阶段性结论。',
            };
          }
        }

        // 检查 wall-clock wrap-up 阈值（默认 85% of maxWallClockMs）
        if (!state.wrapUp && budget) {
          const report = budget.report();
          const maxWallClock = report.hard.wallClockMs;
          const wrapUpThreshold = maxWallClock * contextRatio;

          if (report.elapsedMs >= wrapUpThreshold) {
            state.wrapUp = {
              reason: 'policy',
              turnsRemaining: wrapUpTurns,
              userMessage: `[Resource] 预算策略接近上限（wall_clock: ${Math.round(report.elapsedMs / 1000)}s / ${Math.round(maxWallClock / 1000)}s）。停止新的探索性工具调用；基于已有信息输出结论、证据与未完成项。`,
              hintInjected: false,
            };
            yield {
              type: 'budget.wrap_up',
              timestamp: Date.now(),
              metric: 'policy',
              unit: 'wall_clock_ms',
              used: report.elapsedMs,
              hard: maxWallClock,
              userMessage: state.wrapUp.userMessage,
              resumeHint: 'Run 已进入 wrap-up 模式，请输出阶段性结论。',
            };
          }
        }
      }

      // wrap-up 窗口倒计时
      if (state.wrapUp) {
        state.wrapUp.turnsRemaining--;
        if (state.wrapUp.turnsRemaining <= 0) {
          // wrap-up 窗口结束，触发 stop
          state.budgetStop = {
            reason: state.wrapUp.reason,
            report: { wrapUp: true },
          };
          yield {
            type: 'budget.exceeded',
            timestamp: Date.now(),
            metric: state.wrapUp.reason === 'context' ? 'context' : 'policy',
            userMessage: state.wrapUp.userMessage,
            resumeHint: 'Run 已因 wrap-up 窗口结束而停止。',
          };
        }
      }

      if (budget && !state.budgetStop && !state.wrapUp) {
        const hardResult = budget.checkHardOnly();
        if (hardResult.status === 'hard') {
          state.budgetStop = {
            reason: hardResult.reason ?? 'wall_clock',
            report: hardResult.report,
          };
          yield {
            type: 'budget_exceeded',
            timestamp: Date.now(),
            data: {
              reason: (hardResult.reason ?? 'wall_clock') as
                | 'wall_clock'
                | 'iteration'
                | 'tool_calls',
              report: hardResult.report,
            },
          };
        }
      }
    }

    // onTurnComplete 补判的 hard
    if (state.pendingBudgetHardYield) {
      const hard = state.pendingBudgetHardYield;
      state.pendingBudgetHardYield = false;
      yield {
        type: 'budget_exceeded',
        timestamp: Date.now(),
        data: { reason: hard.reason, report: hard.report },
      };
    }

    // RunGuard 裁决的用户可见事件
    if (state.runGuardStop) {
      const stop = state.runGuardStop;
      state.runGuardStop = false;
      yield {
        type: 'run_guard_stopped',
        timestamp: Date.now(),
        data: { reason: stop.reason, userMessage: stop.userMessage },
      };
    } else if (state.runGuardRecovered) {
      const rec = state.runGuardRecovered;
      state.runGuardRecovered = false;
      yield {
        type: 'run_guard_recovered',
        timestamp: Date.now(),
        data: { reason: rec.reason, actions: rec.actions },
      };
    }

    yield event;
  }
}

// ── 辅助函数 ──

function executeRecoveryActions(
  actions: Array<{ type: string; [key: string]: unknown }>,
  messages: Message[],
): void {
  for (const action of actions) {
    switch (action.type) {
      case 'truncate_context': {
        const keepRecent = (action.keepRecent as number) ?? 8;
        let systemEnd = 0;
        while (systemEnd < messages.length && messages[systemEnd].role === 'system') systemEnd++;
        const nonSystemCount = messages.length - systemEnd;
        const removeCount = nonSystemCount - Math.min(keepRecent, nonSystemCount);
        if (removeCount > 0) {
          messages.splice(systemEnd, removeCount, {
            role: 'user',
            content: `[System: ${removeCount} earlier messages omitted to fit context window.]`,
            timestamp: Date.now(),
            metadata: { source: 'engineHint' },
          });
        }
        break;
      }
      case 'clear_recent_turns': {
        const count = (action.count as number) ?? 2;
        // 从末尾回删 count 条非 system 消息（每条可能是一轮 assistant 或 tool）
        let removed = 0;
        while (removed < count && messages.length > 0) {
          const last = messages[messages.length - 1];
          if (last.role === 'system') break;
          messages.pop();
          removed++;
        }
        if (removed > 0) {
          messages.push({
            role: 'user',
            content: `[System: ${removed} recent messages cleared to recover from a stuck loop.]`,
            timestamp: Date.now(),
            metadata: { source: 'engineHint' },
          });
        }
        break;
      }
      case 'inject_hint':
        messages.push({
          role: 'user',
          content: `[System: ${action.hint}]`,
          timestamp: Date.now(),
          metadata: { source: 'engineHint' },
        });
        break;
    }
  }
}
