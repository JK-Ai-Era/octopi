/**
 * AgentEngine — 核心循环引擎
 *
 * 这是框架的心脏。实现了最小的 Agent 循环：
 *   输入 → 上下文组装 → 模型推理 → [工具执行] → 输出
 *
 * 设计原则：
 * - 不持有持久状态：Session 消息历史由调用方传入，per-run 循环状态在每次 run() 时重置
 * - 纯循环：只负责推理和工具执行，不关心 Session/Protocol
 * - 事件驱动：所有关键节点通过 EventBus 发射事件
 * - 安全内置：SecurityGuard 不可禁用（构造时验证有效性）
 * - 预算强制：IterationBudget 不可绕过
 *
 * 扩展点（回调槽）：
 * - onMessage: 消息到达时（可拦截/修改）
 * - beforeAssemble: 上下文组装前（可注入额外上下文）
 * - beforeModelCall: 模型调用前（可覆盖模型/prompt）
 * - afterModelCall: 模型调用后（可过滤输出）
 * - beforeToolExec: 工具执行前（可拦截/校验）
 * - afterToolExec: 工具执行后（可过滤结果）
 * - afterTurn: 回合结束后（可用于统计/后处理）
 */

import { randomUUID } from 'node:crypto';
import type {
  Message,
  ToolCall,
  ToolResult,
  Turn,
  TokenUsage,
  RegisteredTool,
} from './types.js';
import { getTextContent } from './types.js';
import type {
  ModelProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  ToolDefinition as ModelToolDef,
} from './interfaces/model-provider.js';
import type {
  ToolExecutor,
  ExecutionContext,
} from './interfaces/tool-executor.js';
import type {
  ContextEngine,
  AssembleParams,
  AssembleResult,
} from './interfaces/context-engine.js';
import type {
  ErrorStrategy,
  ClassifiedError,
} from './interfaces/error-strategy.js';
import type {
  TaskSupervisor,
  CheckpointContext,
  CheckpointVerdict,
  TurnSummary,
  RecoveryAction,
} from './interfaces/task-supervisor.js';
import type { Observer } from './interfaces/observer.js';
import type { EventBus, AgentEvent } from './event-bus.js';
import { AgentEvents } from './event-bus.js';
import type { SecurityGuard, SecurityCheckResult, BehaviorContext } from './security-guard.js';
import { isValidSecurityGuard, severityToAction } from './security-guard.js';
import type { SecurityAction } from './interfaces/error-strategy.js';
import { IterationBudget } from './budget.js';
import type { IterationBudgetConfig } from './budget.js';

// ── 配置 ──

/** AgentEngine 依赖注入 */
export interface AgentEngineDeps {
  /** 模型提供者 */
  model: ModelProvider;
  /** 已注册的工具 */
  tools: Map<string, RegisteredTool>;
  /** 工具执行器 */
  executor: ToolExecutor;
  /** 上下文引擎 */
  contextEngine: ContextEngine;
  /** 事件总线 */
  events: EventBus;
  /** 安全守卫 */
  security: SecurityGuard;
  /** 迭代预算 */
  budget: IterationBudget;
  /** 错误策略 */
  errorStrategy: ErrorStrategy;
  /** 观测器（可选） */
  observer?: Observer;
  /** 默认系统提示词（RunConfig.systemPrompt 优先） */
  systemPrompt?: string;
  /** 任务监督器（可选，替代硬预算限制） */
  taskSupervisor?: TaskSupervisor;
  /** 检查点间隔（迭代数，默认 15） */
  checkpointInterval?: number;
  /** planning-only 重试配置 */
  planningRetry?: {
    /** 最大重试次数（默认 2） */
    maxAttempts?: number;
    /** 重试时附加的 steer 指令 */
    steerInstruction?: string;
  };
}

/** 运行配置 */
export interface RunConfig {
  /** 系统提示词（由 Harness 层传入） */
  systemPrompt: string;
  /** Agent ID（用于事件和追踪） */
  agentId?: string;
  /** Session ID（用于事件和追踪） */
  sessionId?: string;
  /** 默认模型 */
  model?: string;
  /** 温度 */
  temperature?: number;
  /** 工作目录（工具用于解析相对路径） */
  cwd?: string;
  /**
   * 外部注入的上下文
   *
   * 由 Harness 层在 engine.run() 之前设置。
   * Core 层不关心内容，只透传给 ContextEngine。
   * 典型用途：任务上下文、用户画像、外部知识等。
   */
  injectedContext?: string;
}

/** @deprecated Use AgentEvent from event-bus instead */
export type EngineEvent = AgentEvent;

// ── 引擎实现 ──

/**
 * AgentEngine — 循环引擎（不持有持久状态）
 */
export class AgentEngine {
  // ── 扩展回调槽 ──
  onMessage?: (msg: Message) => Message | null;
  /**
   * 上下文组装前的回调
   *
   * 用于注入额外上下文或修改参数。
   *
   * @example
   * ```ts
   * beforeAssemble: (input) => {
   *   return { ...input, contextWindow: 128000 };
   * }
   * ```
   */
  beforeAssemble?: (input: { systemPrompt: string; tools: ModelToolDef[]; signal?: AbortSignal; contextWindow?: number }) => { systemPrompt: string; tools: ModelToolDef[]; signal?: AbortSignal; contextWindow?: number } | null;
  beforeModelCall?: (req: LLMRequest) => LLMRequest | null;
  afterModelCall?: (resp: LLMResponse) => LLMResponse;
  beforeToolExec?: (call: ToolCall) => ToolCall | null;
  afterToolExec?: (result: ToolResult) => ToolResult;
  afterTurn?: (turn: Turn) => void;

  /** 依赖（供 Harness 层访问） */
  readonly deps: AgentEngineDeps;

  /** 上下文是否已被截断（防止重复截断） */
  private contextTruncated = false;

  // ── 检查点追踪状态 ──
  private checkpointIterationCount = 0;
  private currentCheckpointInterval = 15;
  private consecutiveErrors = 0;
  private consecutiveSameTool = 0;
  private lastToolName?: string;
  private turnSummaries: TurnSummary[] = [];
  private recentToolCalls: Array<{ name: string; success: boolean }> = [];
  private tokensAtCheckpoint = 0;
  private uniqueTools = new Set<string>();

  // ── Planning-only 重试状态 ──
  private planningOnlyRetryAttempts = 0;
  private planningOnlySteerInjected = false;

  constructor(deps: AgentEngineDeps) {
    // 安全守卫有效性验证：防止调用方传入 noop 实现绕过安全检查
    if (!isValidSecurityGuard(deps.security)) {
      throw new Error(
        'SecurityGuard validation failed: the provided implementation appears to be a no-op. ' +
        'SecurityGuard cannot be bypassed. Use DefaultSecurityGuard or provide a real implementation.',
      );
    }
    this.deps = deps;

    // 如果 SecurityGuard 支持 setRegisteredTools，传入已注册工具列表
    if (deps.security.setRegisteredTools) {
      deps.security.setRegisteredTools(new Set(deps.tools.keys()));
    }
  }

  /**
   * 运行 Agent 循环
   *
   * @param messages - 当前完整消息历史（由调用方提供）
   * @param config - 运行配置
   * @param signal - 中止信号
   * @yields AgentEvent 事件流
   */
  async *run(
    messages: Message[],
    config: RunConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const { model, tools, executor, events, security, budget, errorStrategy, observer } = this.deps;
    const agentId = config.agentId ?? 'default';
    const sessionId = config.sessionId ?? 'inline';
    this.currentCwd = config.cwd;
    this.contextTruncated = false;
    this.checkpointIterationCount = 0;
    this.currentCheckpointInterval = this.deps.checkpointInterval ?? 15;
    this.consecutiveErrors = 0;
    this.consecutiveSameTool = 0;
    this.lastToolName = undefined;
    this.turnSummaries = [];
    this.recentToolCalls = [];
    this.tokensAtCheckpoint = 0;
    this.uniqueTools = new Set();
    this.planningOnlyRetryAttempts = 0;
    this.planningOnlySteerInjected = false;

    // 设置系统提示到 SecurityGuard（用于泄露检测）
    if (security.setSystemPrompt) {
      security.setSystemPrompt(config.systemPrompt || this.deps.systemPrompt || '');
    }

    // 发射引擎启动事件
    events.emit({ type: AgentEvents.ENGINE_START, timestamp: Date.now(), agentId, sessionId });
    yield { type: 'engine.start', timestamp: Date.now(), agentId, sessionId, data: {} };

    // Observer span
    const engineSpan = observer?.startSpan('agent.engine.run', { agentId, sessionId });

    try {
      // 1. 处理最后一条用户消息（安全检查）
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === 'user') {
        const inputCheck = security.checkUserInput(getTextContent(lastMessage.content));
        const inputResult = this.handleSecurityViolation(inputCheck, 'user_input');
        if (inputResult.blocked) {
          yield { type: 'security.blocked', timestamp: Date.now(), data: { reason: inputResult.reason } };
          return;
        }
      }

      // 2. 进入循环

      // 1b. 触发 onMessage 回调
      if (this.onMessage) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg) {
          const modified = this.onMessage(lastMsg);
          if (modified === null) {
            yield { type: "message.filtered", timestamp: Date.now() };
            return;
          }
        }
      }
      let iteration = 0;
      while (true) {
        // 中止检查
        if (signal?.aborted) {
          yield { type: 'interrupted', timestamp: Date.now(), data: { phase: 'iteration_start' } };
          return;
        }

        // 预算检查
        if (!budget.checkAndEmit()) {
          yield { type: AgentEvents.BUDGET_EXCEEDED, timestamp: Date.now(), data: budget.report() as unknown as Record<string, unknown> };
          return;
        }

        iteration++;
        budget.recordIteration();
        events.emit({ type: AgentEvents.ITERATION_START, timestamp: Date.now(), data: { iteration } });
        yield { type: 'iteration.start', timestamp: Date.now(), data: { iteration } };

        const iterSpan = observer?.startSpan('agent.iteration', { iteration });

        try {
          // 2a. 触发 beforeAssemble 回调
          // 查询模型能力，自动注入 contextWindow
          // fallback: config.model → provider.defaultModel → 不查询
          const modelName = config.model || this.deps.model.defaultModel;
          const modelInfo = modelName ? this.deps.model.getModelInfo(modelName) : null;

          const basePrompt = config.systemPrompt || this.deps.systemPrompt || '';
          // 将 injectedContext 追加到 systemPrompt（Core 层不关心内容，只透传）
          const systemPrompt = config.injectedContext != null
            ? basePrompt + '\n\n' + config.injectedContext
            : basePrompt;
          const toolDefs = this.buildToolDefinitions();
          const sessionId = config.sessionId ?? 'inline';

          // 2b. 调用 ContextEngine 组装上下文
          const assembleParams: AssembleParams = {
            sessionId,
            messages,
            systemPrompt,
            tools: toolDefs,
            tokenBudget: modelInfo?.contextWindow ?? 128000,
            contextWindow: modelInfo?.contextWindow,
            signal,
          };

          if (this.beforeAssemble) {
            const modified = this.beforeAssemble({
              systemPrompt,
              tools: toolDefs,
              signal,
              contextWindow: modelInfo?.contextWindow,
            });
            if (modified) {
              assembleParams.systemPrompt = modified.systemPrompt;
              assembleParams.contextWindow = modified.contextWindow;
            }
          }

          const assembled: AssembleResult = await this.deps.contextEngine.assemble(assembleParams);
          const llmMessages = assembled.messages;
          const estimatedTokens = assembled.estimatedTokens;

          // DEBUG: 记录每轮模型调用的上下文
          if (process.env.OCTOPI_DEBUG) {
            const msgSummary = llmMessages.map(m => {
              const contentLen = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length;
              const hasToolCalls = 'tool_calls' in m && Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0;
              const hasToolCallId = 'tool_call_id' in m;
              return `${m.role}${hasToolCalls ? '(+tool_calls)' : ''}${hasToolCallId ? `(id:${(m as any).tool_call_id})` : ''} [${contentLen}ch]`;
            });
            console.error(`[DEBUG] iteration=${iteration} messages=${llmMessages.length} estTokens=${estimatedTokens}`);
            console.error(`[DEBUG] msgs: ${msgSummary.join(' → ')}`);
          }

          // Observer: token 估算
          observer?.recordMetric('agent.context.tokens', estimatedTokens);

          // 2d. 触发 beforeModelCall 回调
          const llmTools = this.buildToolDefinitions();
          let llmRequest: LLMRequest = {
            messages: llmMessages,
            tools: llmTools.length > 0 ? llmTools : undefined,
            model: config.model,
            temperature: config.temperature,
            signal,
          };

          if (this.beforeModelCall) {
            const modified = this.beforeModelCall(llmRequest);
            if (modified === null) {
              // 回调拦截了模型调用
              yield { type: 'model.call.intercepted', timestamp: Date.now() };
              continue;
            }
            llmRequest = modified;
          }

          // 2e. 调用模型
          events.emit({
            type: AgentEvents.MODEL_CALL_START,
            timestamp: Date.now(),
            data: { model: llmRequest.model },
          });
          yield {
            type: 'model.call.start',
            timestamp: Date.now(),
            data: { model: llmRequest.model },
          };

          const modelSpan = observer?.startSpan('agent.model.call', { model: llmRequest.model });
          let llmResponse: LLMResponse;

          try {
            // 流式调用，yield 流式事件
            const callResult = this.callModel(llmRequest, signal);
            let result = await callResult.next();
            while (!result.done) {
              yield result.value;
              result = await callResult.next();
            }
            llmResponse = result.value;
          } catch (err) {
            modelSpan?.setStatus('error');
            modelSpan?.end();

            const classified = this.classifyError(err);

            // ── context_length 特殊处理：尝试截断历史后重试 ──
            if (classified.reason === 'context_length' && !this.contextTruncated) {
              const originalLen = messages.length;
              const truncated = this.truncateMessages(messages);
              if (truncated) {
                this.contextTruncated = true;
                yield {
                  type: 'context.truncated',
                  timestamp: Date.now(),
                  data: { from: originalLen, to: messages.length },
                };
                // 回到循环开头，用截断后的消息重新调用模型
                continue;
              }
            }

            const action = errorStrategy.onModelError(classified, iteration - 1);

            events.emit({ type: AgentEvents.MODEL_CALL_ERROR, timestamp: Date.now(), data: { error: classified } });
            yield { type: 'model.call.error', timestamp: Date.now(), data: { error: classified } };

            if (action.action === 'retry') {
              yield { type: 'retry', timestamp: Date.now(), data: { delayMs: action.delayMs } };
              await this.sleep(action.delayMs, signal);
              continue;
            }
            if (action.action === 'abort') {
              yield { type: 'aborted', timestamp: Date.now(), data: { reason: action.reason } };
              return;
            }
            // fallback/skip: 继续下一次迭代
            continue;
          }

          modelSpan?.end();

          // Observer: token 使用
          if (llmResponse.usage) {
            budget.consumeTokens(llmResponse.usage.totalTokens);
            observer?.recordMetric('agent.model.tokens.input', llmResponse.usage.promptTokens);
            observer?.recordMetric('agent.model.tokens.output', llmResponse.usage.completionTokens);
          }

          // 2f. 触发 afterModelCall 回调
          if (this.afterModelCall) {
            llmResponse = this.afterModelCall(llmResponse);
          }

          // 2g. SecurityGuard 检查模型输出
          // DEBUG: 记录模型响应
          if (process.env.OCTOPI_DEBUG) {
            console.error(`[DEBUG] response: content=${llmResponse.content.length}ch toolCalls=${llmResponse.toolCalls?.length ?? 0} finish=${llmResponse.finishReason} model=${llmResponse.model}`);
            if (llmResponse.content.length === 0 && !llmResponse.toolCalls?.length) {
              console.error(`[DEBUG] ⚠️ EMPTY RESPONSE! Messages sent to model:`);
              for (const m of llmMessages) {
                console.error(`  ${m.role}: ${JSON.stringify(m).substring(0, 300)}`);
              }
            }
          }

          const outputCheck = security.checkModelOutput(llmResponse.content);
          const outputResult = this.handleSecurityViolation(outputCheck, 'model_output');
          if (outputResult.blocked) {
            yield { type: 'security.blocked', timestamp: Date.now(), data: { reason: outputResult.reason } };
            return;
          }

          events.emit({
            type: AgentEvents.MODEL_CALL_END,
            timestamp: Date.now(),
            data: {
              content: llmResponse.content.substring(0, 200),
              toolCallCount: llmResponse.toolCalls?.length ?? 0,
              usage: llmResponse.usage,
            },
          });

          // 2h. 如果有 tool_calls → 执行工具
          if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
            const toolResults: ToolResult[] = [];

            for (const call of llmResponse.toolCalls) {
              // 中止检查
              if (signal?.aborted) {
                yield { type: 'interrupted', timestamp: Date.now(), data: { phase: 'tool_execution' } };
                return;
              }

              // 预算检查
              if (!budget.checkAndEmit()) {
                yield { type: AgentEvents.BUDGET_EXCEEDED, timestamp: Date.now(), data: budget.report() as unknown as Record<string, unknown> };
                return;
              }

              budget.recordToolCall();

              // beforeToolExec 回调
              let processedCall = call;
              if (this.beforeToolExec) {
                const modified = this.beforeToolExec(call);
                if (modified === null) {
                  // 工具被拦截
                  toolResults.push({
                    toolCallId: call.id,
                    name: call.name,
                    result: null,
                    error: 'Tool execution blocked by policy',
                  });
                  continue;
                }
                processedCall = modified;
              }

              // ToolGuard 检查（安全守卫 — 工具调用前）
              const toolCallCheck = security.checkToolCall(processedCall);
              const toolCallResult = this.handleSecurityViolation(toolCallCheck, 'tool_call');
              if (toolCallResult.blocked) {
                // critical：中断整个循环
                yield { type: 'security.blocked', timestamp: Date.now(), data: { reason: toolCallResult.reason } };
                return;
              }
              if (toolCallResult.rejected) {
                // high：拒绝执行，注入上下文告知 LLM
                toolResults.push({
                  toolCallId: processedCall.id,
                  name: processedCall.name,
                  result: null,
                  error: `安全守卫拒绝执行：${toolCallResult.reason}。请使用安全的参数重新尝试或换用其他方法。`,
                });
                yield {
                  type: 'security.tool_rejected',
                  timestamp: Date.now(),
                  data: { toolCallId: processedCall.id, toolName: processedCall.name, reason: toolCallResult.reason },
                };
                continue;
              }

              // 执行工具
              events.emit({
                type: AgentEvents.TOOL_EXEC_START,
                timestamp: Date.now(),
                data: { toolCallId: call.id, toolName: call.name },
              });
              yield {
                type: 'tool.exec.start',
                timestamp: Date.now(),
                data: { toolCallId: call.id, toolName: call.name },
              };

              const toolSpan = observer?.startSpan('agent.tool.exec', { toolName: call.name });
              const toolStartMs = Date.now();
              let toolResult: ToolResult;

              try {
                const result = await executor.execute(processedCall, this.buildExecContext(signal));
                toolResult = {
                  toolCallId: processedCall.id,
                  name: processedCall.name,
                  result,
                  durationMs: Date.now() - toolStartMs,
                };
                toolSpan?.end();
              } catch (err) {
                toolSpan?.setStatus('error');
                toolSpan?.end();

                const classified = this.classifyError(err);
                const action = errorStrategy.onToolError(classified, processedCall);

                if (action.action === 'skip') {
                  toolResult = {
                    toolCallId: processedCall.id,
                    name: processedCall.name,
                    result: null,
                    error: action.reason,
                    durationMs: Date.now() - toolStartMs,
                  };
                } else {
                  toolResult = {
                    toolCallId: processedCall.id,
                    name: processedCall.name,
                    result: null,
                    error: err instanceof Error ? err.message : String(err),
                    durationMs: Date.now() - toolStartMs,
                  };
                }
              }

              // SecurityGuard 检查工具输出
              if (toolResult.result && typeof toolResult.result === 'string') {
                const toolCheck = security.checkToolOutput(toolResult.result);
                const toolOutputResult = this.handleSecurityViolation(toolCheck, 'tool_output');
                if (toolOutputResult.blocked) {
                  yield { type: 'security.blocked', timestamp: Date.now(), data: { reason: toolOutputResult.reason } };
                  return;
                }
                if (toolOutputResult.rejected) {
                  // 工具输出有问题，替换为安全消息
                  toolResult = {
                    ...toolResult,
                    result: null,
                    error: `安全守卫过滤了工具输出：${toolOutputResult.reason}`,
                  };
                }
              }

              // afterToolExec 回调
              if (this.afterToolExec) {
                toolResult = this.afterToolExec(toolResult);
              }

              toolResults.push(toolResult);

              events.emit({
                type: AgentEvents.TOOL_EXEC_END,
                timestamp: Date.now(),
                data: { toolCallId: call.id, toolName: call.name, hasError: !!toolResult.error },
              });
              yield {
                type: 'tool.exec.end',
                timestamp: Date.now(),
                data: { toolCallId: call.id, toolName: call.name, hasError: !!toolResult.error },
              };
            }

            // 将工具结果添加到消息历史
            messages.push({
              role: 'assistant',
              content: llmResponse.content,
              toolCalls: llmResponse.toolCalls,
              timestamp: Date.now(),
            });
            messages.push({
              role: 'tool',
              content: '',
              toolResults,
              timestamp: Date.now(),
            });

            // ── 追踪检查点指标 ──
            this.trackToolResults(llmResponse.toolCalls, toolResults, llmResponse.usage);

            // ── BehaviorGuard 检查（安全守卫 — 行为异常） ──
            const behaviorCtx: BehaviorContext = {
              consecutiveErrors: this.consecutiveErrors,
              consecutiveSameTool: this.consecutiveSameTool,
              lastToolName: this.lastToolName,
              recentToolCalls: this.recentToolCalls,
              uniqueTools: this.uniqueTools.size,
            };
            const behaviorCheck = security.checkBehavior(behaviorCtx);
            const behaviorResult = this.handleSecurityViolation(behaviorCheck, 'behavior');
            if (behaviorResult.blocked) {
              yield {
                type: 'security.behavior_blocked',
                timestamp: Date.now(),
                data: { reason: behaviorResult.reason, violations: behaviorCheck.violations },
              };
              return;
            }
            if (behaviorResult.rejected) {
              // 行为异常但不中断：注入警告到上下文
              messages.push({
                role: 'user',
                content: `[System: ${behaviorResult.reason}。请调整策略，避免重复或危险操作。]`,
                timestamp: Date.now(),
              });
              yield {
                type: 'security.behavior_warning',
                timestamp: Date.now(),
                data: { reason: behaviorResult.reason },
              };
            }

            // ── 检查点审查 ──
            const checkpointVerdict = await this.maybeCheckpoint(iteration, config);
            if (checkpointVerdict) {
              yield {
                type: 'checkpoint',
                timestamp: Date.now(),
                data: { verdict: checkpointVerdict, iteration } as unknown as Record<string, unknown>,
              };
              if (checkpointVerdict.action === 'stop') {
                yield {
                  type: 'checkpoint.stop',
                  timestamp: Date.now(),
                  data: { reason: checkpointVerdict.reason, userMessage: checkpointVerdict.userMessage } as unknown as Record<string, unknown>,
                };
                return;
              }
              if (checkpointVerdict.action === 'recover' && checkpointVerdict.recoveryActions) {
                this.executeRecoveryActions(checkpointVerdict.recoveryActions, messages);
              }
              // 调整下一次检查间隔
              if (checkpointVerdict.nextCheckpointIn) {
                this.currentCheckpointInterval = checkpointVerdict.nextCheckpointIn;
              }
            }

            // 继续循环（让 LLM 看到工具结果）
            continue;
          }

          // 2i. Planning-only 检测与重试
          //    当模型返回纯文本（没有 tool_calls）时，检测是否是 "planning-only" 响应
          //    如果是，重试并附加 "act-now steer" 指令
          if (this.isPlanningOnlyResponse(llmResponse) && this.hasAvailableTools()) {
            const maxAttempts = this.deps.planningRetry?.maxAttempts ?? 2;
            if (this.planningOnlyRetryAttempts < maxAttempts) {
              this.planningOnlyRetryAttempts++;

              // 构建 steer 指令
              const steerInstruction = this.deps.planningRetry?.steerInstruction ??
                'The user expects you to take action now, not just describe what you plan to do. ' +
                'Use the available tools directly. Do not just describe what you will do — actually do it.';

              // 注入 steer 指令到消息历史
              if (!this.planningOnlySteerInjected) {
                messages.push({
                  role: 'user',
                  content: `[System: ${steerInstruction}]`,
                  timestamp: Date.now(),
                });
                this.planningOnlySteerInjected = true;
              }

              events.emit({
                type: 'planning_only_retry',
                timestamp: Date.now(),
                data: {
                  attempt: this.planningOnlyRetryAttempts,
                  maxAttempts,
                  content: llmResponse.content.substring(0, 200),
                },
              });
              yield {
                type: 'planning_only_retry',
                timestamp: Date.now(),
                data: {
                  attempt: this.planningOnlyRetryAttempts,
                  maxAttempts,
                },
              };

              // 继续循环，重试
              continue;
            }
          }

          // 2j. 纯文本回复 → 完成
          const turn: Turn = {
            id: randomUUID(),
            input: messages.slice(0, -1),
            output: { role: 'assistant', content: llmResponse.content, timestamp: Date.now() },
            usage: llmResponse.usage,
            durationMs: 0,
            model: llmResponse.model,
            timestamp: Date.now(),
          };

          // afterTurn 回调
          if (this.afterTurn) {
            this.afterTurn(turn);
          }

          // 调用 ContextEngine 的 afterTurn（如果可用）
          if (this.deps.contextEngine?.afterTurn) {
            await this.deps.contextEngine.afterTurn({
              sessionId: config.sessionId ?? 'inline',
              turn: [turn.output],
              usage: llmResponse.usage ? {
                promptTokens: llmResponse.usage.promptTokens,
                completionTokens: llmResponse.usage.completionTokens,
              } : undefined,
            });
          }

          yield {
            type: 'turn.end',
            timestamp: Date.now(),
            data: { content: llmResponse.content, usage: llmResponse.usage },
          };

          // 循环正常结束
          events.emit({ type: AgentEvents.ENGINE_END, timestamp: Date.now(), data: { reason: 'completed' } });
          engineSpan?.end();
          return;

        } catch (iterError) {
          iterSpan?.setStatus('error');
          iterSpan?.end();
          throw iterError;
        }
      }

    } catch (error) {
      engineSpan?.setStatus('error');
      engineSpan?.end();

      events.emit({
        type: AgentEvents.ENGINE_END,
        timestamp: Date.now(),
        data: { reason: 'error', error: error instanceof Error ? error.message : String(error) },
      });

      yield {
        type: 'engine.error',
        timestamp: Date.now(),
        data: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  // ── 内部方法 ──

  /**
   * 调用模型（流式优先，回退到同步）
   */
  private async *callModel(request: LLMRequest, signal?: AbortSignal): AsyncGenerator<AgentEvent, LLMResponse> {
    const { model } = this.deps;

    // 收集流式响应
    let content = '';
    const toolCallBuffers = new Map<number, { id: string; name: string; argsBuffer: string }>();
    let usage: TokenUsage | undefined;

    try {
      for await (const chunk of model.stream(request)) {
        if (signal?.aborted) throw new Error('Aborted');

        if (chunk.type === 'content' && chunk.content) {
          content += chunk.content;
          yield { type: 'llm_stream_delta', timestamp: Date.now(), data: { delta: chunk.content } };
        }

        if (chunk.type === 'tool_call' && chunk.toolCall) {
          const tc = chunk.toolCall;
          const idx = tc.index ?? 0;
          const existing = toolCallBuffers.get(idx);
          if (existing) {
            if (tc.id) existing.id = tc.id;
            if (tc.name) existing.name = tc.name;
            if (tc.arguments) existing.argsBuffer += tc.arguments;
          } else {
            toolCallBuffers.set(idx, {
              id: tc.id ?? `call_${idx}`,
              name: tc.name ?? '',
              argsBuffer: tc.arguments ?? '',
            });
          }
        }

        if (chunk.type === 'done') {
          if (chunk.usage) usage = chunk.usage;
        }

        if (chunk.type === 'error') {
          throw new Error(chunk.error ?? 'Stream error');
        }
      }
    } catch (err) {
      // 流式失败，回退到同步
      if (err instanceof Error && (err.message.includes('stream') || err.message.includes('Aborted'))) {
        yield { type: 'stream.fallback_to_sync', timestamp: Date.now(), data: { reason: 'stream_error', error: err.message } };
        const response = await model.chat(request);
        if (response.content) {
          yield { type: 'llm_stream_delta', timestamp: Date.now(), data: { delta: response.content } };
        }
        return response;
      }
      throw err;
    }

    // 流式正常结束但内容为空且无工具调用 → fallback 到同步调用
    // 某些 provider 的流式响应可能不完整（缺少 content chunk 或 done chunk）
    if (process.env.OCTOPI_DEBUG) {
      console.error(`[DEBUG] stream结束: content=${content.length}ch toolCalls=${toolCallBuffers.size}`);
    }
    if (!content && toolCallBuffers.size === 0) {
      yield { type: 'stream.fallback_to_sync', timestamp: Date.now(), data: { reason: 'empty_stream' } };
      try {
        const response = await model.chat(request);
        if (response.content) {
          yield { type: 'llm_stream_delta', timestamp: Date.now(), data: { delta: response.content } };
        }
        return response;
      } catch (syncErr) {
        yield { type: 'stream.fallback_failed', timestamp: Date.now(), data: { error: syncErr instanceof Error ? syncErr.message : String(syncErr) } };
      }
    }

    // 构建响应
    const toolCalls: ToolCall[] = [];
    for (const [, buf] of toolCallBuffers) {
      toolCalls.push({
        id: buf.id,
        name: buf.name,
        arguments: (() => { try { return JSON.parse(buf.argsBuffer); } catch { return {}; } })(),
      });
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      model: request.model ?? 'unknown',
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }

  /**
   * 构建工具定义（ModelProvider 格式）
   */
  private buildToolDefinitions(): ModelToolDef[] {
    const defs: ModelToolDef[] = [];
    for (const [, tool] of this.deps.tools) {
      defs.push({
        type: 'function',
        function: {
          name: tool.definition.name,
          description: tool.definition.description,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(tool.definition.parameters).map(([key, param]) => [
                key,
                { type: param.type, description: param.description, ...(param.enum && { enum: param.enum }) },
              ]),
            ),
            required: Object.entries(tool.definition.parameters)
              .filter(([, param]) => param.required)
              .map(([key]) => key),
          },
        },
      });
    }
    return defs;
  }

  /**
   * 构建执行上下文
   */
  /** 当前运行的 cwd（由 RunConfig 传入） */
  private currentCwd?: string;

  private buildExecContext(signal?: AbortSignal): ExecutionContext {
    return {
      timeoutMs: 30_000,
      cwd: this.currentCwd,
      signal,
    } as ExecutionContext & { signal?: AbortSignal };
  }

  /**
   * 统一安全违规处理
   *
   * 根据违规的 severity 决定动作：
   * - critical → block（中断循环）
   * - high → reject（拒绝执行，注入上下文告知 LLM）
   * - medium → warn（警告，继续执行）
   * - low → warn（记录）
   *
   * @returns 处理结果，包含是否阻断和拒绝消息
   */
  private handleSecurityViolation(
    check: SecurityCheckResult,
    source: string,
  ): { blocked: boolean; rejected: boolean; reason?: string } {
    if (check.isClean) return { blocked: false, rejected: false };

    const worst = check.violations.reduce((w, v) => {
      const order = { critical: 4, high: 3, medium: 2, low: 1 };
      return order[v.severity] > order[w.severity] ? v : w;
    }, check.violations[0]);

    const action = severityToAction(worst.severity);

    // 发射安全事件（所有级别都发射）
    this.deps.events.emit({
      type: AgentEvents.INJECTION_DETECTED,
      timestamp: Date.now(),
      data: { source, violations: check.violations, action },
    });

    if (action === 'block') {
      return { blocked: true, rejected: false, reason: worst.description };
    }
    if (action === 'reject') {
      return { blocked: false, rejected: true, reason: worst.description };
    }
    // warn / sanitize
    return { blocked: false, rejected: false };
  }

  /**
   * 分类错误
   *
   * 优先检查 HTTP 状态码（结构化信息），回退到消息文本匹配。
   */
  private classifyError(err: unknown): ClassifiedError {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();

    // 1. 优先从 error 对象提取 HTTP 状态码
    const statusCode = this.extractStatusCode(err);
    let reason: ClassifiedError['reason'] = 'unknown';

    if (statusCode) {
      reason = this.classifyByStatusCode(statusCode);
    }

    // 2. 回退到消息文本匹配
    if (reason === 'unknown') {
      if (lower.includes('rate') && lower.includes('limit')) reason = 'rate_limit';
      else if (lower.includes('context') && lower.includes('length')) reason = 'context_length';
      else if (lower.includes('auth') || lower.includes('401')) reason = 'auth';
      else if (lower.includes('billing') || lower.includes('429')) reason = 'rate_limit';
      else if (lower.includes('timeout') || lower.includes('abort')) reason = 'timeout';
      else if (lower.includes('network') || lower.includes('fetch') || lower.includes('ECONNREFUSED')) reason = 'network';
      else if (lower.includes('500') || lower.includes('502') || lower.includes('503')) reason = 'server';
    }

    // 3. 提取 retry-after
    const retryAfterMs = this.extractRetryAfter(err);

    return { reason, message, originalError: err, retryAfterMs };
  }

  /**
   * 从 error 对象提取 HTTP 状态码
   */
  private extractStatusCode(err: unknown): number | null {
    if (typeof err !== 'object' || err === null) return null;
    const e = err as Record<string, unknown>;
    // 常见属性名
    for (const key of ['status', 'statusCode', 'code', 'httpStatus']) {
      const val = e[key];
      if (typeof val === 'number' && val >= 100 && val < 600) return val;
      if (typeof val === 'string') {
        const n = parseInt(val, 10);
        if (n >= 100 && n < 600) return n;
      }
    }
    // 从 response 对象提取
    if (e.response && typeof e.response === 'object') {
      const resp = e.response as Record<string, unknown>;
      if (typeof resp.status === 'number') return resp.status;
    }
    return null;
  }

  /**
   * 根据 HTTP 状态码分类错误
   */
  private classifyByStatusCode(status: number): ClassifiedError['reason'] {
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'rate_limit';
    if (status === 408 || status === 504) return 'timeout';
    if (status >= 500) return 'server';
    if (status === 400) return 'context_length'; // 400 常见于 context_length_exceeded
    return 'unknown';
  }

  /**
   * 提取 Retry-After 头部（毫秒）
   */
  private extractRetryAfter(err: unknown): number | undefined {
    if (typeof err !== 'object' || err === null) return undefined;
    const e = err as Record<string, unknown>;
    // 检查 retryAfter / retry-after / headers.retry-after
    for (const key of ['retryAfter', 'retry-after', 'retryAfterMs']) {
      const val = e[key];
      if (typeof val === 'number' && val > 0) return val;
      if (typeof val === 'string') {
        const n = parseInt(val, 10);
        if (n > 0) return n * 1000; // 秒 → 毫秒
      }
    }
    // 从 headers 提取
    if (e.headers && typeof e.headers === 'object') {
      const headers = e.headers as Record<string, unknown>;
      const ra = headers['retry-after'] ?? headers['Retry-After'];
      if (typeof ra === 'string') {
        const n = parseInt(ra, 10);
        if (!isNaN(n)) return n * 1000;
      }
    }
    return undefined;
  }

  // ── 检查点方法 ──

  /**
   * 追踪工具执行结果（更新检查点指标）
   */
  private trackToolResults(
    toolCalls: ToolCall[],
    toolResults: ToolResult[],
    usage: { totalTokens: number } | undefined,
  ): void {
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      const result = toolResults[i];
      const success = !result?.error;

      // 追踪连续同一工具
      if (call.name === this.lastToolName) {
        this.consecutiveSameTool++;
      } else {
        this.consecutiveSameTool = 1;
        this.lastToolName = call.name;
      }

      // 追踪唯一工具
      this.uniqueTools.add(call.name);

      // 追踪最近工具调用（滑动窗口 10）
      this.recentToolCalls.push({ name: call.name, success });
      if (this.recentToolCalls.length > 10) {
        this.recentToolCalls.shift();
      }

      // 追踪连续错误
      if (success) {
        this.consecutiveErrors = 0;
      } else {
        this.consecutiveErrors++;
      }
    }

    // 追踪 turn 摘要
    const tokenDelta = usage?.totalTokens ?? 0;
    const toolErrors = toolResults.filter(r => r.error).map(r => r.name);
    this.turnSummaries.push({
      role: 'assistant',
      contentPreview: '',
      toolCalls: toolCalls.map(c => c.name),
      toolErrors: toolErrors.length > 0 ? toolErrors : undefined,
      tokenDelta,
      timestamp: Date.now(),
    });
    // 只保留最近 10 轮摘要
    if (this.turnSummaries.length > 10) {
      this.turnSummaries = this.turnSummaries.slice(-10);
    }
  }

  /**
   * 判断是否需要检查点审查，并在需要时执行
   */
  private async maybeCheckpoint(
    _iteration: number,
    config: RunConfig,
  ): Promise<CheckpointVerdict | null> {
    const supervisor = this.deps.taskSupervisor;
    if (!supervisor) return null;

    this.checkpointIterationCount++;

    // 未到检查点间隔
    if (this.checkpointIterationCount < this.currentCheckpointInterval) {
      return null;
    }

    // 重置计数
    this.checkpointIterationCount = 0;

    // 构建检查点上下文
    const ctx = this.buildCheckpointContext(config);

    // 调用监督节点
    try {
      const verdict = await supervisor.checkpoint(ctx);

      // 根据裁决调整连续错误计数
      if (verdict.action === 'continue') {
        this.consecutiveErrors = 0;
      }

      return verdict;
    } catch {
      // 监督节点本身出错，不影响主循环
      return null;
    }
  }

  /**
   * 构建检查点上下文
   */
  private buildCheckpointContext(config: RunConfig): CheckpointContext {
    const budget = this.deps.budget;
    const report = budget.report();

    // 计算 token 增长率
    const currentTokens = report.totalTokens;
    const tokenGrowthRate = this.tokensAtCheckpoint > 0
      ? (currentTokens - this.tokensAtCheckpoint) / this.tokensAtCheckpoint
      : 0;
    this.tokensAtCheckpoint = currentTokens;

    // 计算工具失败率
    const recentFailures = this.recentToolCalls.filter(t => !t.success).length;
    const toolFailureRate = this.recentToolCalls.length > 0
      ? recentFailures / this.recentToolCalls.length
      : 0;

    // 判断是否有进展（最近 3 轮有新工具调用或新内容）
    const recentSummaries = this.turnSummaries.slice(-3);
    const hasProgress = recentSummaries.some(s =>
      (s.toolCalls && s.toolCalls.length > 0) || s.contentPreview.length > 0
    );

    return {
      sessionId: config.sessionId ?? 'inline',
      agentId: config.agentId ?? 'default',
      iteration: report.iterations,
      totalToolCalls: report.toolCalls,
      totalTokens: report.totalTokens,
      elapsedMs: report.elapsedMs,
      recentSummaries: this.turnSummaries.slice(-5),
      metrics: {
        consecutiveErrors: this.consecutiveErrors,
        consecutiveSameTool: this.consecutiveSameTool,
        tokenGrowthRate,
        toolFailureRate,
        uniqueToolsUsed: this.uniqueTools.size,
        hasProgress,
      },
    };
  }

  /**
   * 执行恢复动作
   */
  private executeRecoveryActions(actions: RecoveryAction[], messages: Message[]): void {
    for (const action of actions) {
      switch (action.type) {
        case 'truncate_context':
          this.truncateMessages(messages, action.keepRecent);
          break;
        case 'inject_hint':
          messages.push({
            role: 'user',
            content: `[System: ${action.hint}]`,
            timestamp: Date.now(),
          });
          break;
        case 'clear_recent_turns':
          const removeCount = action.count * 2;
          if (messages.length > removeCount) {
            messages.splice(-removeCount, removeCount);
          }
          break;
      }
    }
  }

  /**
   * 截断消息历史（应对 context_length 错误或监督节点恢复动作）
   *
   * 策略：保留 system 消息 + 最近的 keepRecent 条非 system 消息，
   * 丢弃中间的历史。
   * 返回 true 如果成功截断，false 如果无法进一步截断。
   *
   * 直接修改 messages 数组（引擎不持有状态，调用方传入的引用）。
   */
  private truncateMessages(messages: Message[], keepRecent = 8): boolean {
    // 找到 system 消息的数量（通常在最前面）
    let systemEnd = 0;
    while (systemEnd < messages.length && messages[systemEnd].role === 'system') {
      systemEnd++;
    }

    const nonSystemCount = messages.length - systemEnd;
    // 至少保留最近 4 条非 system 消息（1 轮 user+assistant+tool 交互）
    const minKeep = 4;
    if (nonSystemCount <= minKeep) {
      return false; // 无法进一步截断
    }

    // 使用参数指定的保留数量，不超过实际消息数
    const actualKeep = Math.min(keepRecent, nonSystemCount);
    const removeCount = nonSystemCount - actualKeep;
    if (removeCount <= 0) return false;

    // 插入一条摘要消息代替被删除的历史
    const summary: Message = {
      role: 'user',
      content: `[System: ${removeCount} earlier messages omitted to fit context window. Conversation continues from here.]`,
      timestamp: Date.now(),
    };

    // 执行截断：system + summary + 最近消息
    messages.splice(systemEnd, removeCount, summary);

    return true;
  }

  /**
   * 可中断的 sleep
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Aborted')); return; }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Aborted')); }, { once: true });
    });
  }

  // ── Planning-only 检测 ──

  // 正则表达式（参考 OpenClaw）
  private static readonly PLANNING_ONLY_PROMISE_RE = /\b(?:i(?:'ll| will)|let me|i(?:'m| am)\s+going to|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|i can do that)\b/i;
  private static readonly PLANNING_ONLY_COMPLETION_RE = /\b(?:done|finished|implemented|updated|fixed|changed|ran|verified|found|here(?:'s| is) what|blocked by|the blocker is)\b/i;
  private static readonly PLANNING_ONLY_HEADING_RE = /^(?:plan|steps?|next steps?)\s*:/i;
  private static readonly PLANNING_ONLY_BULLET_RE = /^(?:[-*•]\s+|\d+[.)]\s+)/u;
  private static readonly PLANNING_ONLY_MAX_VISIBLE_TEXT = 700;
  private static readonly PLANNING_ONLY_ACTION_VERB_RE = /\b(?:inspect|investigate|check|look(?:\s+into|\s+at)?|read|search|find|debug|fix|patch|update|change|edit|write|implement|run|test|verify|review|analy(?:s|z)e|summari(?:s|z)e|explain|answer|show|share|report|prepare|capture|take|refactor|restart|deploy|ship)\b/i;

  // 中文模式
  private static readonly PLANNING_ONLY_PROMISE_ZH_RE = /(?:我会|让我|接下来我|我将|我需要|首先我|下一步我)/;
  private static readonly PLANNING_ONLY_ACTION_VERB_ZH_RE = /(?:查看|分析|检查|读取|列出|搜索|研究|执行|运行|测试|验证|审查|总结|解释|回答|展示|分享|报告|准备|捕获|获取|重构|重启|部署)/;
  private static readonly PLANNING_ONLY_COMPLETION_ZH_RE = /(?:完成|已完成|已实现|已更新|已修复|已更改|已运行|已验证|已找到|以下是|结果是|被阻塞|阻塞原因)/;

  /**
   * 检测模型响应是否是 "planning-only"（只描述了要做什么，但没有实际执行工具）
   *
   * 参考 OpenClaw 的 planning-only 检测逻辑：
   * 1. 检测是否包含承诺性语言（如 "I'll", "Let me", "I will" 等）
   * 2. 检测是否包含行动动词（如 "analyze", "check", "read" 等）
   * 3. 检测结构化计划格式（如 "Plan:" 开头 + 列表项）
   * 4. 排除已完成的响应（如 "done", "finished" 等）
   */
  private isPlanningOnlyResponse(response: LLMResponse): boolean {
    // 必须有内容
    if (!response.content || response.content.trim().length === 0) {
      return false;
    }

    // 有 tool_calls 不是 planning-only
    if (response.toolCalls && response.toolCalls.length > 0) {
      return false;
    }

    const text = response.content.trim();

    // 排除太短的响应（可能是简单回答）
    if (text.length < 20) {
      return false;
    }

    // 排除太长的响应（可能是详细分析）- OpenClaw 使用 700 字符
    if (text.length > AgentEngine.PLANNING_ONLY_MAX_VISIBLE_TEXT) {
      return false;
    }

    // 排除包含代码块的响应（可能是代码输出）
    if (text.includes('```')) {
      return false;
    }

    // 检测结构化计划格式
    const hasStructuredFormat = this.hasStructuredPlanningOnlyFormat(text);

    // 检测承诺性语言（英文 + 中文）
    const hasPromise = AgentEngine.PLANNING_ONLY_PROMISE_RE.test(text) ||
                       AgentEngine.PLANNING_ONLY_PROMISE_ZH_RE.test(text);

    // 如果既没有结构化格式也没有承诺性语言，不是 planning-only
    if (!hasPromise && !hasStructuredFormat) {
      return false;
    }

    // 检测行动动词（英文 + 中文）- 结构化格式时可选
    if (!hasStructuredFormat) {
      const hasActionVerb = AgentEngine.PLANNING_ONLY_ACTION_VERB_RE.test(text) ||
                            AgentEngine.PLANNING_ONLY_ACTION_VERB_ZH_RE.test(text);
      if (!hasActionVerb) {
        return false;
      }
    }

    // 排除已完成的响应（英文 + 中文）
    const isCompletion = AgentEngine.PLANNING_ONLY_COMPLETION_RE.test(text) ||
                         AgentEngine.PLANNING_ONLY_COMPLETION_ZH_RE.test(text);
    if (isCompletion) {
      return false;
    }

    return true;
  }

  /**
   * 检测是否有结构化计划格式
   *
   * 特征：
   * - 以 "Plan:" 或 "Steps:" 等标题开头
   * - 包含列表项（- 或 1. 等）
   * - 包含承诺性语言
   */
  private hasStructuredPlanningOnlyFormat(text: string): boolean {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return false;

    // 检测列表项数量
    const bulletLineCount = lines.filter(line =>
      AgentEngine.PLANNING_ONLY_BULLET_RE.test(line)
    ).length;

    // 检测是否有承诺性语言
    const hasPlanningCueLine = lines.some(line =>
      AgentEngine.PLANNING_ONLY_PROMISE_RE.test(line) ||
      AgentEngine.PLANNING_ONLY_PROMISE_ZH_RE.test(line)
    );

    // 结构化格式：标题行 + 承诺性语言，或 2+ 列表项 + 承诺性语言
    return (AgentEngine.PLANNING_ONLY_HEADING_RE.test(lines[0] ?? '') && hasPlanningCueLine) ||
           (bulletLineCount >= 2 && hasPlanningCueLine);
  }

  /**
   * 检查是否有可用的工具
   */
  private hasAvailableTools(): boolean {
    return this.deps.tools.size > 0;
  }
}
