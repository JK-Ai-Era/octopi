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
  ContextPipeline,
  PipelineInput,
  PipelineOutput,
} from './interfaces/context-pipeline.js';
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
import type { EventBus } from './event-bus.js';
import { AgentEvents } from './event-bus.js';
import type { SecurityGuard } from './security-guard.js';
import { isValidSecurityGuard } from './security-guard.js';
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
  /** 上下文管道 */
  context: ContextPipeline;
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
}

/** Agent 事件（v2.0，与旧版 AgentEvent 兼容） */
export interface EngineEvent {
  type: string;
  timestamp: number;
  agentId?: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

// ── 引擎实现 ──

/**
 * AgentEngine — 循环引擎（不持有持久状态）
 */
export class AgentEngine {
  // ── 扩展回调槽 ──
  onMessage?: (msg: Message) => Message | null;
  beforeAssemble?: (input: PipelineInput) => PipelineInput;
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

  constructor(deps: AgentEngineDeps) {
    // 安全守卫有效性验证：防止调用方传入 noop 实现绕过安全检查
    if (!isValidSecurityGuard(deps.security)) {
      throw new Error(
        'SecurityGuard validation failed: the provided implementation appears to be a no-op. ' +
        'SecurityGuard cannot be bypassed. Use DefaultSecurityGuard or provide a real implementation.',
      );
    }
    this.deps = deps;
  }

  /**
   * 运行 Agent 循环
   *
   * @param messages - 当前完整消息历史（由调用方提供）
   * @param config - 运行配置
   * @param signal - 中止信号
   * @yields EngineEvent 事件流
   */
  async *run(
    messages: Message[],
    config: RunConfig,
    signal?: AbortSignal,
  ): AsyncGenerator<EngineEvent> {
    const { model, tools, executor, context, events, security, budget, errorStrategy, observer } = this.deps;
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
        if (!inputCheck.isClean) {
          const action = errorStrategy.onSecurityViolation({
            ...inputCheck.violations[0],
            source: 'user_input',
          });
          if (action.action === 'block') {
            yield { type: 'security.blocked', timestamp: Date.now(), data: { reason: action.reason } };
            return;
          }
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
          let pipelineInput: PipelineInput = {
            systemPrompt: config.systemPrompt || this.deps.systemPrompt || '',
            tools: this.buildToolDefinitions(),
            signal,
          };

          if (this.beforeAssemble) {
            const modified = this.beforeAssemble(pipelineInput);
            if (modified) pipelineInput = modified;
          }

          // 2b. 调用 ContextPipeline 组装上下文
          const pipelineOutput: PipelineOutput = await context.process(messages, pipelineInput);

          // Observer: token 估算
          observer?.recordMetric('agent.context.tokens', pipelineOutput.estimatedTokens);

          // 2c. SecurityGuard 检查上下文中的不可信内容
          // （由 ContextPipeline 的 filter stage 标记，SecurityGuard 在模型输出后检查）

          // 2d. 触发 beforeModelCall 回调
          const llmTools = this.buildToolDefinitions();
          let llmRequest: LLMRequest = {
            messages: pipelineOutput.messages,
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
          const outputCheck = security.checkModelOutput(llmResponse.content);
          if (!outputCheck.isClean) {
            yield { type: 'security.output_flagged', timestamp: Date.now(), data: { violations: outputCheck.violations } };
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
                if (!toolCheck.isClean) {
                  yield { type: 'security.tool_output_flagged', timestamp: Date.now(), data: { violations: toolCheck.violations } };
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

          // 2i. 纯文本回复 → 完成
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
  private async *callModel(request: LLMRequest, signal?: AbortSignal): AsyncGenerator<EngineEvent, LLMResponse> {
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
}
