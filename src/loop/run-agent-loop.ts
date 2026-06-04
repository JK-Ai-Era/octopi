/**
 * Agent Loop — 核心循环
 *
 * 基于异步生成器的 Agent Loop，原生支持事件流。
 * 每次迭代经过三层：Meta-Decision → LLM Decision → Tool Execution。
 *
 * 设计来源：
 * - OpenClaw: EventStream 模式、AbortSignal、convertToLlm
 * - hermes-agent: IterationBudget、ErrorClassifier、重试策略、工具验证
 * - Octopi: Plugin Hook 系统、Task Management
 */

import type {
  AgentEvent,
  AgentLoopConfig,
  AdvisorContext,
  ClassifiedError,
  LLMMessage,
  LLMStreamChunk,
  LoopEndReason,
  Message,
  MetaDecision,
  ToolCall,
  ToolResult,
  TurnResult,
} from '../core/types.js';
import type { PluginManager } from '../plugins/manager.js';
import type { BeforeIterationResult } from '../plugins/manager.js';
import { IterationBudget } from './iteration-budget.js';
import {
  classifyError,
  isRetryable,
  jitteredBackoff,
} from './error-classifier.js';

// ── 内部工具类型（匹配 LLM 返回格式） ──

interface LLMToolCallRaw {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// ── 生成唯一 ID ──

let _idCounter = 0;
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++_idCounter}`;
}

// ── 可中断的 sleep ──

function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timer = setTimeout(resolve, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ── 工具参数验证与修复 ──

const HOUSEKEEPING_TOOLS = new Set([
  'memory', 'todo', 'skill_manage', 'session_search',
]);

function validateAndRepairToolCalls(
  toolCalls: LLMToolCallRaw[],
): LLMToolCallRaw[] {
  return toolCalls.map((tc) => {
    let args = tc.function.arguments;

    // 空字符串 → 空对象
    if (!args || !args.trim()) {
      return { ...tc, function: { ...tc.function, arguments: '{}' } };
    }

    // 验证 JSON 有效性
    try {
      JSON.parse(args);
    } catch {
      // 尝试修复常见问题
      const trimmed = args.trim();
      // 可能是截断的 JSON
      if (!trimmed.endsWith('}') && !trimmed.endsWith(']')) {
        // 截断 — 标记为无效，上层处理
        return tc;
      }
      // 其他格式问题 — 返回原样，上层处理
    }

    return tc;
  });
}

function deduplicateToolCalls(toolCalls: LLMToolCallRaw[]): LLMToolCallRaw[] {
  const seen = new Set<string>();
  const result: LLMToolCallRaw[] = [];

  for (const tc of toolCalls) {
    const key = `${tc.function.name}:${tc.function.arguments}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(tc);
    }
  }

  return result;
}

function hasTruncatedArgs(toolCalls: LLMToolCallRaw[]): boolean {
  return toolCalls.some((tc) => {
    const args = (tc.function.arguments ?? '').trim();
    if (!args || args === '{}') return false;
    try {
      JSON.parse(args);
      return false;
    } catch {
      // 不以 } 或 ] 结尾 → 截断
      return !args.endsWith('}') && !args.endsWith(']');
    }
  });
}

// ══════════════════════════════════════════════════════
// 主循环
// ══════════════════════════════════════════════════════

/**
 * 运行 Agent Loop
 *
 * 返回 AsyncIterable<AgentEvent>，调用方可以 for await 消费事件。
 *
 * @param config - 循环配置
 * @param input - 用户输入消息
 * @param signal - 中止信号
 */
export async function* runAgentLoop(
  config: AgentLoopConfig,
  input: Message,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  const {
    provider,
    contextEngine,
    toolRegistry,
    messageConverter,
    advisors,
    pluginManager,
  } = config;

  // 排序 advisors（priority 越小越先执行）
  const sortedAdvisors = [...advisors].sort((a, b) => a.priority - b.priority);

  const budget = new IterationBudget(config.iterationBudget);
  const messages: Message[] = [input];
  let turnIndex = 0;
  let consecutiveErrors = 0;
  let lastResponse: string | undefined;
  let loopEndReason: LoopEndReason = 'error';
  let loopEndResponse: string | undefined;

  // 构建 session ID（从 input 的 metadata 或生成）
  const sessionId = (input.metadata?.sessionId as string) ?? generateId('session');

  yield { type: 'loop_start', sessionId };

  try {
    // ── 主循环 ──
    while (true) {
      // ── 检查中断 ──
      if (signal?.aborted) {
        yield { type: 'interrupted', phase: 'loop_check' };
        yield { type: 'loop_end', reason: 'interrupted' };
        return;
      }

      // ── 检查预算 ──
      if (!budget.consume()) {
        yield { type: 'loop_end', reason: 'budget_exhausted', response: lastResponse };
        return;
      }

      // ── 检查轮次 ──
      if (turnIndex >= config.maxTurns) {
        yield { type: 'loop_end', reason: 'max_turns', response: lastResponse };
        return;
      }

      const turnId = generateId('turn');
      yield { type: 'turn_start', turnId, turnIndex };

      // ══════════════════════════════════════════
      // Layer 1: Meta-Decision (顾问层)
      // ══════════════════════════════════════════

      const advisorCtx: AdvisorContext = {
        sessionId,
        turnId,
        turnIndex,
        messages: [...messages],
        iterationBudget: {
          used: budget.used,
          remaining: budget.remaining,
          max: budget.max,
        },
        abortSignal: signal ?? new AbortController().signal,
      };

      const decisions: MetaDecision[] = [];

      for (const advisor of sortedAdvisors) {
        if (signal?.aborted) break;

        yield { type: 'advisor_call', advisor: advisor.name };

        try {
          const decision = await advisor.beforeTurn(advisorCtx);
          if (decision) {
            decisions.push(decision);

            // 处理消息注入
            if (decision.injectMessages?.length) {
              messages.push(...decision.injectMessages);
              yield {
                type: 'messages_injected',
                count: decision.injectMessages.length,
                source: advisor.name,
              };
            }

            // 处理停止决策
            if (decision.shouldStop) {
              yield { type: 'turn_end', turnId, shouldContinue: false };
              yield {
                type: 'loop_end',
                reason: 'advisor_stop',
                response: decision.stopReason,
              };
              return;
            }
          }
        } catch (error) {
          // advisor 失败不应阻塞整个循环
          yield {
            type: 'error',
            error: classifyError(error, undefined, undefined),
            retrying: false,
          };
        }
      }

      yield { type: 'meta_decision', decisions };

      // 合并所有 decisions 的覆盖项
      const merged = mergeDecisions(decisions);

      // ══════════════════════════════════════════
      // Layer 2: LLM Decision (模型层)
      // ══════════════════════════════════════════

      // 检查是否需要压缩上下文
      const shouldCompact = contextEngine.info.ownsCompaction
        ? false  // 自管理压缩的引擎自己处理
        : messages.length > 50; // 简单启发式

      if (shouldCompact) {
        try {
          const result = await contextEngine.compact({
            sessionId,
            force: false,
          });
          if (result.compacted) {
            yield {
              type: 'context_compressed',
              beforeTokens: messages.length, // 简化：用消息数代替 token 数
              afterTokens: 0, // compact 后由引擎管理
            };
          }
        } catch {
          // 压缩失败不阻塞循环
        }
      }

      // 组装 LLM 请求
      const llmMessages: LLMMessage[] = messageConverter.toLlm(messages);

      let model = merged.overrideModel ?? config.defaultModel;

      // ══════════════════════════════════════════
      // Plugin Hook: before_iteration (迭代级，Octopi 独有)
      // ══════════════════════════════════════════
      let iterationPluginContext: string | undefined;

      if (pluginManager) {
        const iterResult = await pluginManager.runHook<BeforeIterationResult | null>(
          'before_iteration',
          {
            iteration: turnIndex,
            messages: [...messages],
            model,
            thinking: merged.overrideThinking,
            sessionId,
            ctx: { sessionId, turnId, turnIndex },
          },
          null,
        );

        if (iterResult) {
          if (iterResult.model) model = iterResult.model;
          if (iterResult.thinking) merged.overrideThinking = iterResult.thinking;
          if (iterResult.prependContext) iterationPluginContext = iterResult.prependContext;
          if (iterResult.stop) {
            yield { type: 'loop_end', reason: 'plugin_stop', response: iterResult.stopReason };
            return;
          }
        }
      }

      // 合并 taskContext + iterationPluginContext 到 system prompt
      const injectedContext = [merged.taskContext, iterationPluginContext]
        .filter(Boolean)
        .join('\n\n');

      if (injectedContext) {
        const systemIdx = llmMessages.findIndex((m) => m.role === 'system');
        if (systemIdx >= 0) {
          llmMessages[systemIdx].content =
            (llmMessages[systemIdx].content ?? '') + '\n\n' + injectedContext;
        } else {
          llmMessages.unshift({
            role: 'system',
            content: injectedContext,
          });
        }
      }

      yield {
        type: 'llm_request',
        model,
        estimatedTokens: estimateTokens(llmMessages),
      };

      // 流式调用（带重试）
      let llmResponse: {
        content: string;
        thinking?: string;
        toolCalls?: LLMToolCallRaw[];
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
        durationMs: number;
      };

      try {
        llmResponse = await streamLLMWithRetry(
          provider,
          model,
          llmMessages,
          signal,
          (chunk) => {
            if (chunk.type === 'thinking') {
              // 作为 event 推送，但不累积到 content
              // 注意：这里 yield 不行，需要用 onEvent 回调
            }
            // 流式 delta 通过 onEvent 回调
            config.onEvent?.(
              chunk.type === 'thinking'
                ? { type: 'llm_thinking_delta', delta: chunk.text }
                : { type: 'llm_stream_delta', delta: chunk.text },
            );
          },
          config.retry,
          merged.overrideThinking,
        );
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors++;
        const classified = classifyError(error, provider.name, model);

        yield { type: 'error', error: classified, retrying: false };

        if (classified.reason === 'context_length' && consecutiveErrors < 3) {
          // 上下文过长 → 压缩后重试
          try {
            await contextEngine.compact({ sessionId, force: true });
            budget.refund(); // 退还本次迭代
            continue;
          } catch {
            // 压缩也失败了
          }
        }

        if (consecutiveErrors >= config.maxConsecutiveErrors) {
          yield { type: 'loop_end', reason: 'error' };
          return;
        }

        budget.refund();
        continue;
      }

      yield {
        type: 'llm_response',
        content: llmResponse.content,
        toolCalls: llmResponse.toolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: parseArguments(tc.function.arguments),
        })),
        usage: llmResponse.usage,
        durationMs: llmResponse.durationMs,
      };

      // 记录 assistant 消息
      const assistantMsg: Message = {
        role: 'assistant',
        content: llmResponse.content,
        timestamp: Date.now(),
        toolCalls: llmResponse.toolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: parseArguments(tc.function.arguments),
        })),
      };
      messages.push(assistantMsg);

      // 如果没有 tool calls → 最终响应
      if (!llmResponse.toolCalls?.length) {
        lastResponse = llmResponse.content;
        yield { type: 'turn_end', turnId, shouldContinue: false };

        // Plugin Hook: loop_end
        if (pluginManager) {
          await pluginManager.runAllHooks('loop_end', {
            iterations: turnIndex + 1,
            messages: [...messages],
            reason: 'completed',
            response: lastResponse,
            success: true,
            sessionId,
            ctx: { sessionId, turnId, turnIndex },
          });
        }

        yield { type: 'loop_end', reason: 'completed', response: lastResponse };

        // 通知 advisors 循环结束
        for (const advisor of sortedAdvisors) {
          await advisor.onLoopEnd?.(advisorCtx);
        }
        return;
      }

      // ══════════════════════════════════════════
      // Layer 3: Tool Execution (执行层)
      // ══════════════════════════════════════════

      const toolCalls = llmResponse.toolCalls;

      // 参数验证 + 修复
      const validatedCalls = validateAndRepairToolCalls(toolCalls);

      // 去重
      const dedupedCalls = deduplicateToolCalls(validatedCalls);

      // 截断检测
      if (hasTruncatedArgs(dedupedCalls)) {
        yield {
          type: 'loop_end',
          reason: 'error',
          response: 'Tool call arguments truncated due to output length limit',
        };
        return;
      }

      // 构建 TurnResult 的工具结果收集
      const toolResultsForTurn: ToolResult[] = [];

      // 逐个执行工具
      for (const tc of dedupedCalls) {
        if (signal?.aborted) {
          yield { type: 'interrupted', phase: 'tool_execution' };
          yield { type: 'loop_end', reason: 'interrupted' };
          return;
        }

        const tcId = tc.id;
        const tcName = tc.function.name;
        const tcArgs = tc.function.arguments;

        yield {
          type: 'tool_call_start',
          toolCallId: tcId,
          toolName: tcName,
          arguments: tcArgs,
        };

        const startTime = Date.now();

        try {
          const parsedArgs = JSON.parse(tcArgs || '{}');
          const result = await toolRegistry.execute(
            tcName,
            parsedArgs,
            {
              sessionId,
              turnId,
              abortSignal: signal,
            },
          );

          const durationMs = Date.now() - startTime;
          const resultStr = typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);

          yield {
            type: 'tool_call_result',
            toolCallId: tcId,
            toolName: tcName,
            result: resultStr,
            durationMs,
          };

          // 工具结果加入消息
          const toolMsg: Message = {
            role: 'tool',
            content: result.error ? `Error: ${result.error}` : resultStr,
            timestamp: Date.now(),
            toolResults: [{
              toolCallId: tcId,
              name: tcName,
              result: result.result,
              error: result.error,
              durationMs,
            }],
          };
          messages.push(toolMsg);

          toolResultsForTurn.push({
            toolCallId: tcId,
            name: tcName,
            result: result.result,
            error: result.error,
            durationMs,
          });
        } catch (error) {
          const durationMs = Date.now() - startTime;
          const errorMsg = error instanceof Error ? error.message : String(error);

          yield {
            type: 'tool_call_error',
            toolCallId: tcId,
            toolName: tcName,
            error: errorMsg,
          };

          // 错误也作为 tool result 加入消息（让 LLM 看到并恢复）
          const toolMsg: Message = {
            role: 'tool',
            content: `Error: ${errorMsg}`,
            timestamp: Date.now(),
            toolResults: [{
              toolCallId: tcId,
              name: tcName,
              result: null,
              error: errorMsg,
              durationMs,
            }],
          };
          messages.push(toolMsg);

          toolResultsForTurn.push({
            toolCallId: tcId,
            name: tcName,
            result: null,
            error: errorMsg,
            durationMs,
          });
        }
      }

      // ── Turn 后处理 ──
      const turnResult: TurnResult = {
        assistantMessage: assistantMsg,
        toolResults: toolResultsForTurn,
        tokenUsage: llmResponse.usage,
        durationMs: llmResponse.durationMs,
      };

      yield { type: 'turn_end', turnId, shouldContinue: true };

      // 通知 advisors turn 结束
      for (const advisor of sortedAdvisors) {
        await advisor.afterTurn?.(advisorCtx, turnResult);
      }

      // ══════════════════════════════════════════
      // Plugin Hook: after_iteration (迭代级，Octopi 独有)
      // ══════════════════════════════════════════
      if (pluginManager) {
        await pluginManager.runAllHooks('after_iteration', {
          iteration: turnIndex,
          assistantMessage: assistantMsg,
          toolCalls: assistantMsg.toolCalls ?? [],
          toolResults: toolResultsForTurn,
          usage: llmResponse.usage,
          sessionId,
          ctx: { sessionId, turnId, turnIndex },
        });
      }

      // 检查 steering 消息
      if (config.onSteering) {
        const steeringMsgs = await config.onSteering();
        if (steeringMsgs.length > 0) {
          // steering 消息经过 advisor 处理
          let steeringBlocked = false;
          for (const advisor of sortedAdvisors) {
            const decision = await advisor.onSteering?.(steeringMsgs);
            if (decision?.injectMessages) {
              messages.push(...decision.injectMessages);
            }
            if (decision?.shouldStop) {
              yield { type: 'loop_end', reason: 'advisor_stop' };
              steeringBlocked = true;
              break;
            }
          }
          if (!steeringBlocked) {
            messages.push(...steeringMsgs);
            yield {
              type: 'messages_injected',
              count: steeringMsgs.length,
              source: 'steering',
            };
          }
        }
      }

      turnIndex++;
    }
  } catch (error) {
    const classified = classifyError(error);
    yield { type: 'error', error: classified, retrying: false };

    // Plugin Hook: loop_end (error)
    if (pluginManager) {
      await pluginManager.runAllHooks('loop_end', {
        iterations: turnIndex,
        messages: [...messages],
        reason: 'error',
        response: lastResponse,
        success: false,
        sessionId,
        ctx: { sessionId, turnId: 'error', turnIndex },
      });
    }

    yield { type: 'loop_end', reason: 'error' };
  }
}

// ══════════════════════════════════════════════════════
// 辅助函数
// ══════════════════════════════════════════════════════

/**
 * 合并多个 MetaDecision
 *
 * 后面的 decision 优先级更高（覆盖前面的）。
 * injectMessages 累加。
 */
function mergeDecisions(decisions: MetaDecision[]): MetaDecision {
  const merged: MetaDecision = {};

  for (const d of decisions) {
    if (d.injectMessages?.length) {
      merged.injectMessages = [...(merged.injectMessages ?? []), ...d.injectMessages];
    }
    if (d.overrideModel) merged.overrideModel = d.overrideModel;
    if (d.overrideThinking) merged.overrideThinking = d.overrideThinking;
    if (d.overrideMaxTokens) merged.overrideMaxTokens = d.overrideMaxTokens;
    if (d.shouldStop) {
      merged.shouldStop = true;
      merged.stopReason = d.stopReason;
    }
    if (d.taskContext) {
      merged.taskContext = (merged.taskContext ?? '') + '\n\n' + d.taskContext;
    }
  }

  return merged;
}

/**
 * 粗略估算 token 数（4 字符 ≈ 1 token）
 */
function estimateTokens(messages: LLMMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.content) total += Math.ceil(msg.content.length / 4);
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += Math.ceil(tc.function.arguments.length / 4);
      }
    }
  }
  return total;
}

/**
 * 流式 LLM 调用（带重试）
 *
 * 如果 provider 支持 stream()，使用流式；否则 fallback 到 complete()。
 * 自动处理 rate limit 的 Retry-After。
 */
async function streamLLMWithRetry(
  provider: any,
  model: string,
  messages: LLMMessage[],
  signal: AbortSignal | undefined,
  onDelta: (chunk: LLMStreamChunk) => void,
  retryConfig: { maxRetries: number; baseDelayMs: number; maxDelayMs: number },
  thinkingLevel?: string,
): Promise<{
  content: string;
  thinking?: string;
  toolCalls?: LLMToolCallRaw[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  durationMs: number;
}> {
  let lastError: ClassifiedError | null = null;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    try {
      const startTime = Date.now();

      // 尝试流式调用
      if (typeof provider.stream === 'function') {
        const request: any = {
          model,
          messages: messages as any[],
          stream: true,
        };

        const streamIterable = provider.stream(request);
        let content = '';
        let thinking = '';
        let toolCalls: LLMToolCallRaw[] | undefined;
        let usage: any;

        for await (const chunk of streamIterable) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

          if (chunk.content) {
            content += chunk.content;
            onDelta({ type: 'content', text: chunk.content });
          }
          if (chunk.thinking) {
            thinking += chunk.thinking;
            onDelta({ type: 'thinking', text: chunk.thinking });
          }
          if (chunk.toolCalls) {
            toolCalls = chunk.toolCalls;
          }
          if (chunk.usage) {
            usage = chunk.usage;
          }
        }

        return {
          content,
          thinking: thinking || undefined,
          toolCalls,
          usage,
          durationMs: Date.now() - startTime,
        };
      }

      // Fallback: 同步调用
      const request: any = {
        model,
        messages: messages as any[],
      };

      const response = await provider.complete(request);

      return {
        content: response.content ?? '',
        toolCalls: response.toolCalls?.map((tc: any) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
          },
        })),
        usage: response.usage,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      lastError = classifyError(error, provider.name, model);

      // 不可重试的错误
      if (!isRetryable(lastError)) {
        throw lastError;
      }

      if (attempt < retryConfig.maxRetries) {
        const waitMs = lastError.retryAfterMs
          ?? jitteredBackoff(attempt, retryConfig.baseDelayMs, retryConfig.maxDelayMs);

        // 发出重试等待事件（通过 onDelta 的包装 — 实际用 onEvent）
        // 这里直接 throw 给上层处理
        await interruptibleSleep(waitMs, signal);
      }
    }
  }

  throw lastError!;
}

/**
 * 将 JSON 字符串解析为 Record<string, unknown>
 * 用于 ToolCall.arguments 的类型适配
 */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}
