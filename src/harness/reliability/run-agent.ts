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

import type { Message, ToolCall } from '../../core/types.js';
import { getTextContent } from '../../core/types.js';
import type {
  AgentContext,
  AgentLoopConfig,
  AgentLoopEvent,
  LoopToolResult,
  TurnContext,
} from '../../loop/types.js';
import type { HarnessLoopEvent } from './harness-events.js';
import { classifyError } from '../../loop/error-classifier.js';
import { agentLoop } from '../../loop/agent-loop.js';
import type {
  ToolCallRecord,
  ToolLoopDetectionConfig,
} from '../concurrency/tool-loop-detection.js';
import {
  recordToolCall,
  detectNoProgressLoop,
  hashToolCall,
} from '../concurrency/tool-loop-detection.js';
import type { SecurityGuard } from '../../core/security-guard.js';
import { severityToAction } from '../../core/security-guard.js';
import type { ErrorStrategy, ClassifiedError as CoreClassifiedError } from '../../core/interfaces/error-strategy.js';
import type { RunGuard, CheckpointContext, CheckpointVerdict, TurnSummary } from '../../core/interfaces/run-guard.js';
import type { ReliabilityHarness as CoreReliabilityHarness } from '../../core/interfaces/reliability.js';
import { RunMetricsCollector } from './run-metrics-collector.js';
import { IterationBudget } from '../budget/budget.js';
import { NoopEventBus } from '../../core/primitives/event-bus.js';
import { getRunScope } from '../run-scope.js';

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
    reason: 'tokens' | 'wall_clock' | 'iteration' | 'tool_calls';
    report?: unknown;
  };
  /** SecurityGuard 拦截：在 generator 主循环 yield（beforeToolCall 不能 yield） */
  pendingSecurityEvents: Array<{
    type: 'security_blocked';
    timestamp: number;
    data: Record<string, unknown>;
  }>;
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
    budget = new IterationBudget(
      new NoopEventBus(),
      budget.getConfig() as import('../budget/budget.js').IterationBudgetConfig,
    );
  }

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

    // beforeToolCall：Budget hard 闸 + SecurityGuard 检查 + 原始回调
    beforeToolCall: async (ctx, signal) => {
      // Budget hard：阻止本批工具继续执行（turn_end 在工具之前 yield）
      if (budget && !state.budgetStop) {
        const hard = budget.checkHardOnly();
        if (hard.status === 'hard') {
          state.budgetStop = {
            reason: hard.reason ?? 'tokens',
            report: hard.report,
          };
          state.pendingBudgetHardYield = {
            reason: (hard.reason ?? 'tokens') as
              | 'tokens'
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
          reason: `Budget exceeded (${typeof state.budgetStop === 'object' ? state.budgetStop.reason : 'resource'})`,
          terminate: true,
        };
      }
      // SecurityGuard 检查
      if (harness.security) {
        const toolCheck = harness.security.checkToolCall(ctx.toolCall);
        if (!toolCheck.isClean) {
          const action = severityToAction(
            toolCheck.violations.reduce((worst, v) => {
              const order = { critical: 4, high: 3, medium: 2, low: 1 };
              return order[v.severity] > order[worst.severity] ? v : worst;
            }, toolCheck.violations[0]).severity,
          );
          if (action === 'block' || action === 'reject') {
            const scope = getRunScope();
            state.pendingSecurityEvents.push({
              type: 'security_blocked',
              timestamp: Date.now(),
              data: {
                sessionId: scope?.sessionId,
                agentId: scope?.agentId,
                reason: toolCheck.violations[0]?.description,
                toolName: ctx.toolCall.name,
                action,
                severity: toolCheck.violations[0]?.severity,
                violations: toolCheck.violations.map((v) => ({
                  type: v.type,
                  severity: v.severity,
                  description: v.description,
                })),
              },
            });
            return {
              block: true,
              reason: toolCheck.violations[0]?.description,
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
          if (action === 'block' || action === 'reject') {
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

      // 0b. Budget soft（工具路径：token 已在 turn_end 入账，此处用本轮新鲜 hasProgress）
      //     文本路径首轮 soft 由 turn_end 分支处理（onTurnComplete 时尚未入账）
      if (budget && !state.budgetStop) {
        const softEval = budget.evaluate(state.hasProgress);
        if (softEval.status === 'soft') {
          if (harness.runGuard) {
            state.collector.noteExternalSignal({
              source: 'budget_soft',
              level: 'warning',
              detail: `预算 soft 触达（${softEval.reason ?? 'tokens'}），且无实质进展`,
              timestamp: Date.now(),
            });
            state.forceCheckpoint = true;
          } else {
            state.budgetStop = {
              reason: softEval.reason ?? 'tokens',
              report: softEval.report,
            };
            state.pendingBudgetHardYield = {
              reason: (softEval.reason ?? 'tokens') as
                | 'tokens'
                | 'wall_clock'
                | 'iteration'
                | 'tool_calls',
              report: softEval.report,
            };
          }
        } else if (softEval.status === 'hard') {
          state.budgetStop = {
            reason: softEval.reason ?? 'tokens',
            report: softEval.report,
          };
          state.pendingBudgetHardYield = {
            reason: (softEval.reason ?? 'tokens') as
              | 'tokens'
              | 'wall_clock'
              | 'iteration'
              | 'tool_calls',
            report: softEval.report,
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
            });
          } else {
            // 超过阈值：标记停止 + 立即检查点
            (state as any)._noopLoopStop = true;
            state.forceCheckpoint = true;
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
      if (hasToolCalls && relConfig.loopDetection.enabled !== false) {
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
              } else {
                state.loopCriticalTriggered = true;
                ctx.context.messages.push({
                  role: 'user',
                  content: `[System: ${loopResult.message} Stop calling tools and provide your final response based on the information gathered so far.]`,
                  timestamp: Date.now(),
                });
              }
            } else if (loopResult.level === 'warning') {
              ctx.context.messages.push({
                role: 'user',
                content: `[System: ${loopResult.message}]`,
                timestamp: Date.now(),
              });
            }
          }
        }

        // 更新追踪指标
        for (const result of ctx.toolResults) {
          state.collector.recordToolResult(result.name, !result.isError, !!result.noop);
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
          if (action.delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, action.delayMs));
          }
          return 'retry';
        }
        return 'abort';
      }

      // 默认：重试 rate_limit / timeout / server（最多 3 次，避免无界重试）
      if (classified.reason === 'rate_limit' || classified.reason === 'timeout' || classified.reason === 'server') {
        if (attempt < 3) {
          const delayMs = classified.retryAfterMs ?? (attempt + 1) * 1000;
          if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
          return 'retry';
        }
        return 'abort';
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
    // Observer：run 结束前附带 RunMetricsCollector 快照（P1 Guard 面板）
    if (event.type === 'agent_end') {
      const scope = getRunScope();
      yield {
        type: 'run_guard_metrics',
        timestamp: Date.now(),
        data: state.collector.toObserverSnapshot({
          sessionId: scope?.sessionId,
          agentId: scope?.agentId,
        }),
      };
    }
    if (event.type === 'tool_end') {
      // maxToolCalls 计量（显式配置时才硬停）
      budget?.recordToolCall(1);
    }

    if (event.type === 'turn_end') {
      // 错误重试 turn_end 带的是上一次成功的 usage，禁止双计
      if (event.usage?.totalTokens && !event.error) {
        const delta = event.usage.totalTokens;
        state.collector.recordTokens(delta);
        budget?.consumeTokens(delta);
      }
      budget?.recordIteration();

      // turn_end：token 已入账后立刻判 hard
      // soft：
      // - 文本路径（!hasToolCalls）：onTurnComplete 已更新 hasProgress，此处补判
      // - 工具路径：hasProgress 尚未更新，soft 留给 onTurnComplete
      if (budget && !state.budgetStop) {
        const hardResult = budget.checkHardOnly();
        if (hardResult.status === 'hard') {
          state.budgetStop = {
            reason: hardResult.reason ?? 'tokens',
            report: hardResult.report,
          };
          yield {
            type: 'budget_exceeded',
            timestamp: Date.now(),
            data: {
              reason: (hardResult.reason ?? 'tokens') as
                | 'tokens'
                | 'wall_clock'
                | 'iteration'
                | 'tool_calls',
              report: hardResult.report,
            },
          };
        } else if (!event.hasToolCalls) {
          const softEval = budget.evaluate(state.hasProgress);
          if (softEval.status === 'soft') {
            if (harness.runGuard) {
              state.collector.noteExternalSignal({
                source: 'budget_soft',
                level: 'warning',
                detail: `预算 soft 触达（${softEval.reason ?? 'tokens'}），且无实质进展`,
                timestamp: Date.now(),
              });
              state.forceCheckpoint = true;
            } else {
              state.budgetStop = {
                reason: softEval.reason ?? 'tokens',
                report: softEval.report,
              };
              state.pendingBudgetHardYield = {
                reason: (softEval.reason ?? 'tokens') as
                  | 'tokens'
                  | 'wall_clock'
                  | 'iteration'
                  | 'tool_calls',
                report: softEval.report,
              };
            }
          } else if (softEval.status === 'hard') {
            state.budgetStop = {
              reason: softEval.reason ?? 'tokens',
              report: softEval.report,
            };
            yield {
              type: 'budget_exceeded',
              timestamp: Date.now(),
              data: {
                reason: (softEval.reason ?? 'tokens') as
                  | 'tokens'
                  | 'wall_clock'
                  | 'iteration'
                  | 'tool_calls',
                report: softEval.report,
              },
            };
          }
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
          });
        }
        break;
      }
      case 'inject_hint':
        messages.push({
          role: 'user',
          content: `[System: ${action.hint}]`,
          timestamp: Date.now(),
        });
        break;
    }
  }
}
