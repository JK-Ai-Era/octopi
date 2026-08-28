/**
 * Harness 层可靠性包装
 *
 * 包装 agentLoop()，注入所有可靠性行为：
 * - Planning-only 检测与重试
 * - 空响应重试
 * - 工具循环检测
 * - No-op 检测
 * - TaskSupervisor 检查点
 * - SecurityGuard 安全检查（通过 beforeToolCall 注入）
 * - ErrorStrategy 重试策略（通过 onError 注入）
 *
 * 设计原则：
 * - 使用 onTurnComplete 做副作用（注入 steer 指令），不直接控制停止
 * - 使用 shouldStopAfterTurn 做停止决策（critical 循环、TaskSupervisor）
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
} from '../../core/loop/types.js';
import { classifyError } from '../../core/loop/error-classifier.js';
import { agentLoop } from '../../core/loop/agent-loop.js';
import type {
  ToolCallRecord,
  ToolLoopDetectionConfig,
} from '../../core/tool-loop-detection.js';
import {
  recordToolCall,
  detectNoProgressLoop,
  hashToolCall,
} from '../../core/tool-loop-detection.js';
import type { SecurityGuard } from '../../core/security-guard.js';
import { severityToAction } from '../../core/security-guard.js';
import type { ErrorStrategy, ClassifiedError as CoreClassifiedError } from '../../core/interfaces/error-strategy.js';
import type { TaskSupervisor, CheckpointContext, CheckpointVerdict, TurnSummary } from '../../core/interfaces/task-supervisor.js';

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

export interface ReliabilityHarness {
  config: ReliabilityConfig;
  security?: SecurityGuard;
  errorStrategy?: ErrorStrategy;
  taskSupervisor?: TaskSupervisor;
  /** 当前 agentId（用于检查点） */
  agentId?: string;
  /** 当前 sessionId（用于检查点） */
  sessionId?: string;
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
  turnSummaries: TurnSummary[];
  consecutiveErrors: number;
  consecutiveSameTool: number;
  lastToolName: string;
  uniqueTools: Set<string>;
  recentToolCalls: Array<{ name: string; success: boolean }>;
  checkpointIterationCount: number;
  currentCheckpointInterval: number;
  tokensAtCheckpoint: number;
}

function createInitialState(): ReliabilityState {
  return {
    planningOnlyAttempts: 0,
    planningOnlySteerInjected: false,
    emptyResponseAttempts: 0,
    emptyResponseSteerInjected: false,
    consecutiveNoops: 0,
    toolCallHistory: [],
    loopCriticalTriggered: false,
    turnSummaries: [],
    consecutiveErrors: 0,
    consecutiveSameTool: 0,
    lastToolName: '',
    uniqueTools: new Set(),
    recentToolCalls: [],
    checkpointIterationCount: 0,
    currentCheckpointInterval: 15,
    tokensAtCheckpoint: 0,
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
  harness: ReliabilityHarness,
  signal?: AbortSignal,
): AsyncGenerator<AgentLoopEvent> {
  const state = createInitialState();
  const relConfig = { ...DEFAULT_RELIABILITY_CONFIG, ...harness.config };

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

    // beforeToolCall：SecurityGuard 检查 + 原始回调
    beforeToolCall: async (ctx, signal) => {
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
          if (action === 'block') {
            return { block: true, reason: toolCheck.violations[0]?.description };
          }
          if (action === 'reject') {
            return { block: true, reason: toolCheck.violations[0]?.description, terminate: false };
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
      // SecurityGuard 检查工具输出
      if (harness.security && ctx.result.content && typeof ctx.result.content === 'string') {
        const outputCheck = harness.security.checkToolOutput(ctx.result.content);
        if (!outputCheck.isClean) {
          const action = severityToAction(
            outputCheck.violations.reduce((worst, v) => {
              const order = { critical: 4, high: 3, medium: 2, low: 1 };
              return order[v.severity] > order[worst.severity] ? v : worst;
            }, outputCheck.violations[0]).severity,
          );
          if (action === 'block' || action === 'reject') {
            return { content: null, isError: true };
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
      const hasToolCalls = ctx.toolResults.length > 0;
      const contentText = getTextContent(ctx.message.content);
      const hasContent = contentText.trim().length > 0;
      const hasToolCallInMessage = ctx.message.toolCalls && ctx.message.toolCalls.length > 0;

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
            // 超过阈值：标记停止
            (state as any)._noopLoopStop = true;
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
            if (loopResult.level === 'critical') {
              if (state.loopCriticalTriggered) {
                // 二次 critical：通过 shouldStopAfterTurn 停止
                // 标记，让下面的 shouldStopAfterTurn 检查
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
        trackToolResults(ctx.toolResults, state);
      }

      // 5. TaskSupervisor 检查点
      if (harness.taskSupervisor) {
        state.checkpointIterationCount++;
        if (state.checkpointIterationCount >= state.currentCheckpointInterval) {
          state.checkpointIterationCount = 0;
          try {
            const verdict = await harness.taskSupervisor.checkpoint(
              buildCheckpointContext(state, harness),
            );
            if (verdict.action === 'stop') {
              (state as any)._taskSupervisorStop = true;
              (state as any)._taskSupervisorReason = verdict.reason;
            } else if (verdict.action === 'recover' && verdict.recoveryActions) {
              executeRecoveryActions(verdict.recoveryActions, ctx.context.messages);
            }
            if (verdict.nextCheckpointIn) {
              state.currentCheckpointInterval = verdict.nextCheckpointIn;
            }
          } catch {
            // 监督节点出错不影响主循环
          }
        }
      }

      // 调用用户的 onTurnComplete（如果有）
      if (config.onTurnComplete) {
        await config.onTurnComplete(ctx);
      }
    },

    // shouldStopAfterTurn：停止决策
    shouldStopAfterTurn: async (ctx) => {
      // 1. 二次循环 critical → 停止
      if ((state as any)._loopCriticalTwice) {
        return true;
      }
      // 2. TaskSupervisor 要求停止
      if ((state as any)._taskSupervisorStop) {
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
    onError: async (error) => {
      const classified = classifyError(error);

      // ErrorStrategy 决策
      if (harness.errorStrategy) {
        const action = harness.errorStrategy.onModelError(classified, 0);
        if (action.action === 'retry') return 'retry';
        if (action.action === 'abort') return 'abort';
        return 'throw';
      }

      // 默认：重试 rate_limit 和 timeout
      if (classified.reason === 'rate_limit' || classified.reason === 'timeout' || classified.reason === 'server') {
        if (classified.retryAfterMs) {
          await new Promise(resolve => setTimeout(resolve, classified.retryAfterMs));
        }
        return 'retry';
      }
      if (classified.reason === 'auth') return 'abort';
      return 'throw';
    },
  };

  // 运行核心循环
  yield* agentLoop(context, wrappedConfig, signal);
}

// ── 辅助函数 ──

function trackToolResults(toolResults: LoopToolResult[], state: ReliabilityState): void {
  for (const result of toolResults) {
    const success = !result.isError;
    if (result.name === state.lastToolName) {
      state.consecutiveSameTool++;
    } else {
      state.consecutiveSameTool = 1;
      state.lastToolName = result.name;
    }
    state.uniqueTools.add(result.name);
    state.recentToolCalls.push({ name: result.name, success });
    if (state.recentToolCalls.length > 10) state.recentToolCalls.shift();
    if (success) {
      state.consecutiveErrors = 0;
    } else {
      state.consecutiveErrors++;
    }
  }
}

function buildCheckpointContext(state: ReliabilityState, harness: ReliabilityHarness): CheckpointContext {
  const recentFailures = state.recentToolCalls.filter(t => !t.success).length;
  const toolFailureRate = state.recentToolCalls.length > 0
    ? recentFailures / state.recentToolCalls.length
    : 0;

  return {
    sessionId: harness.sessionId ?? 'inline',
    agentId: harness.agentId ?? 'default',
    iteration: state.checkpointIterationCount,
    totalToolCalls: state.recentToolCalls.length,
    totalTokens: 0,
    elapsedMs: 0,
    recentSummaries: state.turnSummaries.slice(-5),
    metrics: {
      consecutiveErrors: state.consecutiveErrors,
      consecutiveSameTool: state.consecutiveSameTool,
      tokenGrowthRate: 0,
      toolFailureRate,
      uniqueToolsUsed: state.uniqueTools.size,
      hasProgress: true,
    },
  };
}

function executeRecoveryActions(actions: Array<{ type: string; [key: string]: unknown }>, messages: Message[]): void {
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
