/**
 * Agent 核心循环 — 纯函数
 *
 * 职责：调用 LLM → 解析响应 → 执行工具 → 循环
 * 不持有状态，不依赖外部组件实例。
 *
 * 不包含：重试逻辑、消息注入、循环检测、no-op 检测。
 * 这些机制由 Harness 层通过回调和外部循环实现。
 *
 * 流式输出：通过 callModel() 的 async generator 逐 chunk yield llm_stream_delta。
 */

import { randomUUID } from 'node:crypto';
import type { Message, ToolCall, TokenUsage } from '../core/types.js';
import type { LLMMessage, LLMResponse, ToolDefinition as ModelToolDef } from '../core/interfaces/model-provider.js';
import type {
  AgentContext,
  AgentLoopConfig,
  AgentLoopEvent,
  AgentTool,
  LoopToolResult,
  BeforeToolCallResult,
  ClassifiedError,
} from './types.js';
import type { ToolResult as CoreToolResult } from '../core/types.js';
import { callModel } from './call-model.js';
import { classifyError } from './error-classifier.js';

/**
 * Agent 核心循环
 *
 * @param context - 初始上下文（消息历史 + 工具列表）
 * @param config - 循环配置（模型 + 回调 + 超时）
 * @param signal - 中止信号
 * @yields AgentLoopEvent 事件流
 * @returns 最终的上下文（包含完整消息历史）
 */
export async function* agentLoop(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
): AsyncGenerator<AgentLoopEvent> {
  const {
    model,
    convertToLlm,
    transformContext,
    beforeToolCall,
    afterToolCall,
    shouldStopAfterTurn,
    onTurnComplete,
    prepareNextTurn,
    onError,
    observer,
    getSteeringMessages,
    getFollowUpMessages,
  } = config;

  const toolExecution = config.toolExecution ?? 'parallel';
  const idleTimeoutMs = config.modelCallIdleTimeoutMs ?? 120_000;
  const absoluteTimeoutMs = config.modelCallAbsoluteTimeoutMs ?? 300_000;

  // 将 systemPrompt 注入为 system 消息（如果尚未存在）
  if (context.systemPrompt && !context.messages.some(m => m.role === 'system')) {
    context.messages.unshift({
      role: 'system',
      content: context.systemPrompt,
      timestamp: Date.now(),
    });
  }

  // 当前上下文（循环内直接修改 messages 引用）
  let currentContext = context;
  let currentModel = model;

  yield { type: 'agent_start', timestamp: Date.now() };

  while (true) {
    // ── 中止检查 ──
    if (signal?.aborted) {
      yield { type: 'agent_end', reason: 'aborted', timestamp: Date.now() };
      return;
    }

    yield { type: 'turn_start', timestamp: Date.now() };

    // ── 1. 上下文变换（可选） ──
    if (transformContext) {
      currentContext.messages = await transformContext(currentContext.messages, signal);
    }

    // ── 2. 消息格式转换（内部格式 → LLM 格式） ──
    const toolDefs = buildToolDefinitions(currentContext.tools);
    const llmMessages: LLMMessage[] = convertToLlm
      ? await convertToLlm(currentContext.messages)
      : normalizeMessagesForLlm(currentContext.messages);

    // ── 3. 调用 LLM（带超时保护 + 流式输出） ──
    observer?.onLLMStart?.({ model: currentModel.name });

    let response: LLMResponse;
    try {
      const callResult = callModel(
        currentModel,
        llmMessages,
        toolDefs,
        signal,
        { idleTimeoutMs, absoluteTimeoutMs },
      );

      // 透传流式事件
      let result = await callResult.next();
      while (!result.done) {
        yield result.value; // llm_stream_delta / stream.fallback_to_sync 等
        result = await callResult.next();
      }
      response = result.value; // 最终的 LLMResponse
    } catch (llmError) {
      // LLM 调用失败（stream + chat 都失败）：通知 onError，让 Harness 决定重试/中止
      const classified = classifyError(llmError);
      if (onError) {
        const action = await onError(classified);
        if (action === 'retry') {
          yield { type: 'turn_end', hasToolCalls: false, error: true };
          continue; // 重试当前迭代
        }
        if (action === 'abort') {
          yield { type: 'agent_end', reason: 'error', timestamp: Date.now(), error: llmError };
          return;
        }
        // action === 'throw'：继续抛出
      }
      // 没有 onError 或 onError 返回 'throw'：yield 错误事件后退出
      yield { type: 'agent_end', reason: 'error', timestamp: Date.now(), error: llmError };
      return;
    }

    observer?.onLLMEnd?.({ model: currentModel.name, usage: response.usage });

    // ── 4. 构建 assistant 消息并加入历史 ──
    const assistantMessage: Message = {
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
      timestamp: Date.now(),
    };
    currentContext.messages.push(assistantMessage);
    yield { type: 'assistant_message', message: assistantMessage, timestamp: Date.now() };

    // ── 5. finishReason 校验（LLM 协议层，非策略） ──
    if (response.finishReason === 'length') {
      if (response.toolCalls?.length) {
        // 输出被截断，所有 tool call 可能不完整
        const errorResults: LoopToolResult[] = [];
        for (const tc of response.toolCalls) {
          yield { type: 'tool_start', toolCall: tc, timestamp: Date.now() };
          errorResults.push({
            toolCallId: tc.id,
            name: tc.name,
            content: `Error: Response was truncated, tool call "${tc.name}" may be incomplete. Re-issue with complete arguments.`,
            isError: true,
          });
        }
        for (const er of errorResults) {
          yield { type: 'tool_end', toolCall: { id: er.toolCallId, name: er.name, arguments: {} }, result: er, timestamp: Date.now() };
        }

        // 一次 push 所有截断的工具错误结果
        const coreResults: CoreToolResult[] = errorResults.map(r => ({
          toolCallId: r.toolCallId,
          name: r.name,
          result: null,
          error: String(r.content),
          durationMs: r.durationMs,
        }));
        currentContext.messages.push({
          role: 'tool',
          content: '',
          toolResults: coreResults,
          timestamp: Date.now(),
        });

        // 通知 onTurnComplete（副作用）
        if (onTurnComplete) {
          await onTurnComplete({ message: assistantMessage, toolResults: errorResults, context: currentContext });
        }

        // 检查用户停止条件
        if (shouldStopAfterTurn) {
          const stop = await shouldStopAfterTurn({ message: assistantMessage, toolResults: errorResults, context: currentContext });
          if (stop) {
            yield { type: 'turn_end', hasToolCalls: true, truncated: true };
            yield { type: 'agent_end', reason: 'should_stop', timestamp: Date.now() };
            return;
          }
        }

        yield { type: 'turn_end', hasToolCalls: true, truncated: true };
        continue;
      }
    }

    // ── 6. 解析响应：有无工具调用 ──
    const toolCalls = response.toolCalls ?? [];

    if (toolCalls.length === 0) {
      // 纯文本回复 → 检查 followUp 消息队列
      // 通知 onTurnComplete
      if (onTurnComplete) {
        await onTurnComplete({ message: assistantMessage, toolResults: [], context: currentContext });
      }

      // 检查用户停止条件
      if (shouldStopAfterTurn) {
        const stop = await shouldStopAfterTurn({ message: assistantMessage, toolResults: [], context: currentContext });
        if (stop) {
          yield { type: 'turn_end', hasToolCalls: false };
          yield { type: 'agent_end', reason: 'should_stop', timestamp: Date.now() };
          return;
        }
      }

      // 检查 followUp 消息队列
      const followUps = getFollowUpMessages ? await getFollowUpMessages() : [];
      if (followUps.length > 0) {
        currentContext.messages.push(...followUps);
        yield { type: 'turn_end', hasToolCalls: false };
        continue;
      }

      // 无工具调用 + 无 followUp → 自然结束
      yield { type: 'turn_end', hasToolCalls: false };
      yield { type: 'agent_end', reason: 'completed', timestamp: Date.now() };
      return;
    }

    // ── 7. 执行工具 ──
    yield { type: 'turn_end', hasToolCalls: true };

    // 7a. 为每个工具调用发出 tool_start 事件
    for (const tc of toolCalls) {
      yield { type: 'tool_start', toolCall: tc, timestamp: Date.now() };
    }

    const toolResults = await executeToolCalls(
      toolCalls,
      currentContext,
      toolExecution,
      beforeToolCall,
      afterToolCall,
      observer,
      signal,
    );

    // 7b. 为每个工具结果发出 tool_end 事件
    for (const result of toolResults) {
      yield { type: 'tool_end', toolCall: { id: result.toolCallId, name: result.name, arguments: {} }, result, timestamp: Date.now() };
    }

    // 将工具结果加入消息历史（一次 push，使用 toolResults 数组）
    const coreResults: CoreToolResult[] = toolResults.map(r => ({
      toolCallId: r.toolCallId,
      name: r.name,
      result: r.isError ? null : r.content,
      error: r.isError ? String(r.content) : undefined,
      durationMs: r.durationMs,
      noop: r.noop,
    }));
    currentContext.messages.push({
      role: 'tool',
      content: '',
      toolResults: coreResults,
      timestamp: Date.now(),
    });

    // ── 8. 轮次后处理 ──

    // onTurnComplete（Harness 内部副作用）
    if (onTurnComplete) {
      await onTurnComplete({ message: assistantMessage, toolResults, context: currentContext });
    }

    // shouldStopAfterTurn（用户停止条件）
    if (shouldStopAfterTurn) {
      const stop = await shouldStopAfterTurn({ message: assistantMessage, toolResults, context: currentContext });
      if (stop) {
        yield { type: 'agent_end', reason: 'should_stop', timestamp: Date.now() };
        return;
      }
    }

    // prepareNextTurn（动态配置切换）
    if (prepareNextTurn) {
      const update = await prepareNextTurn({ message: assistantMessage, toolResults, context: currentContext });
      if (update) {
        if (update.context) currentContext = update.context;
        if (update.model) currentModel = update.model;
      }
    }

    // 检查 steering 消息
    const steering = getSteeringMessages ? await getSteeringMessages() : [];
    if (steering.length > 0) {
      currentContext.messages.push(...steering);
    }

    // 继续循环
  }
}

// ── 工具执行 ──

/**
 * 执行一批工具调用
 */
async function executeToolCalls(
  toolCalls: ToolCall[],
  context: AgentContext,
  mode: 'parallel' | 'sequential',
  beforeToolCall: AgentLoopConfig['beforeToolCall'],
  afterToolCall: AgentLoopConfig['afterToolCall'],
  observer: AgentLoopConfig['observer'],
  signal?: AbortSignal,
): Promise<LoopToolResult[]> {
  const hasSequentialTool = toolCalls.some(
    (tc) => context.tools?.find((t) => t.name === tc.name)?.executionMode === 'sequential',
  );

  if (mode === 'sequential' || hasSequentialTool) {
    return executeSequential(toolCalls, context, beforeToolCall, afterToolCall, observer, signal);
  }
  return executeParallel(toolCalls, context, beforeToolCall, afterToolCall, observer, signal);
}

/**
 * 串行执行工具调用
 */
async function executeSequential(
  toolCalls: ToolCall[],
  context: AgentContext,
  beforeToolCall: AgentLoopConfig['beforeToolCall'],
  afterToolCall: AgentLoopConfig['afterToolCall'],
  observer: AgentLoopConfig['observer'],
  signal?: AbortSignal,
): Promise<LoopToolResult[]> {
  const results: LoopToolResult[] = [];
  for (const tc of toolCalls) {
    if (signal?.aborted) break;
    const result = await executeOneTool(tc, context, beforeToolCall, afterToolCall, observer, signal);
    results.push(result);
  }
  return results;
}

/**
 * 并行执行工具调用（prepare 串行，execute 并行）
 */
async function executeParallel(
  toolCalls: ToolCall[],
  context: AgentContext,
  beforeToolCall: AgentLoopConfig['beforeToolCall'],
  afterToolCall: AgentLoopConfig['afterToolCall'],
  observer: AgentLoopConfig['observer'],
  signal?: AbortSignal,
): Promise<LoopToolResult[]> {
  // Prepare 阶段串行（参数校验 + beforeToolCall）
  const prepared: Array<
    | { kind: 'prepared'; toolCall: ToolCall; tool: AgentTool; args: unknown }
    | { kind: 'immediate'; toolCall: ToolCall; result: LoopToolResult }
  > = [];

  for (const tc of toolCalls) {
    const prep = await prepareToolCall(tc, context, beforeToolCall, signal);
    if (prep.kind === 'immediate') {
      prepared.push({ kind: 'immediate', toolCall: tc, result: prep.result });
    } else {
      prepared.push({ kind: 'prepared', toolCall: tc, tool: prep.tool, args: prep.args });
    }
  }

  // Execute 阶段并行
  const executePromises = prepared.map(async (p) => {
    if (p.kind === 'immediate') return p.result;

    observer?.onToolStart?.({ toolCall: p.toolCall });
    const startTime = Date.now();

    try {
      const result = await p.tool.execute(p.toolCall.id, p.args, signal);
      const toolResult: LoopToolResult = {
        ...result,
        durationMs: Date.now() - startTime,
      };
      observer?.onToolEnd?.({ toolCall: p.toolCall, result: toolResult });
      return toolResult;
    } catch (error) {
      const errorResult: LoopToolResult = {
        toolCallId: p.toolCall.id,
        name: p.toolCall.name,
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
        durationMs: Date.now() - startTime,
      };
      observer?.onToolEnd?.({ toolCall: p.toolCall, result: errorResult });
      return errorResult;
    }
  });

  const executed = await Promise.all(executePromises);

  // afterToolCall 阶段串行（保持顺序）
  const results: LoopToolResult[] = [];
  for (let i = 0; i < executed.length; i++) {
    let result = executed[i];
    const prepEntry = prepared[i];
    if (afterToolCall && !result.isError) {
      const afterResult = await afterToolCall(
        { toolCall: toolCalls[i], args: prepEntry.kind === 'prepared' ? prepEntry.args : undefined, result, context },
        signal,
      );
      if (afterResult) {
        result = {
          ...result,
          content: afterResult.content ?? result.content,
          isError: afterResult.isError ?? result.isError,
          terminate: afterResult.terminate ?? result.terminate,
        };
      }
    }
    results.push(result);
  }

  return results;
}

/**
 * 执行单个工具（prepare + execute + afterToolCall）
 */
async function executeOneTool(
  toolCall: ToolCall,
  context: AgentContext,
  beforeToolCall: AgentLoopConfig['beforeToolCall'],
  afterToolCall: AgentLoopConfig['afterToolCall'],
  observer: AgentLoopConfig['observer'],
  signal?: AbortSignal,
): Promise<LoopToolResult> {
  // Prepare
  const prepared = await prepareToolCall(toolCall, context, beforeToolCall, signal);
  if (prepared.kind === 'immediate') return prepared.result;

  // Execute
  observer?.onToolStart?.({ toolCall });
  const startTime = Date.now();

  let result: LoopToolResult;
  try {
    const executed = await prepared.tool.execute(toolCall.id, prepared.args, signal);
    result = { ...executed, durationMs: Date.now() - startTime };
  } catch (error) {
    result = {
      toolCallId: toolCall.id,
      name: toolCall.name,
      content: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
      durationMs: Date.now() - startTime,
    };
  }

  observer?.onToolEnd?.({ toolCall, result });

  // afterToolCall
  if (afterToolCall && !result.isError) {
    const afterResult = await afterToolCall(
      { toolCall, args: prepared.args, result, context },
      signal,
    );
    if (afterResult) {
      result = {
        ...result,
        content: afterResult.content ?? result.content,
        isError: afterResult.isError ?? result.isError,
        terminate: afterResult.terminate ?? result.terminate,
      };
    }
  }

  return result;
}

/**
 * 准备工具调用（查找工具 + 参数预处理 + 校验 + beforeToolCall）
 */
async function prepareToolCall(
  toolCall: ToolCall,
  context: AgentContext,
  beforeToolCall: AgentLoopConfig['beforeToolCall'],
  signal?: AbortSignal,
): Promise<
  | { kind: 'prepared'; tool: AgentTool; args: unknown }
  | { kind: 'immediate'; result: LoopToolResult }
> {
  const tool = context.tools?.find((t) => t.name === toolCall.name);
  if (!tool) {
    return {
      kind: 'immediate',
      result: {
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: `Error: Tool "${toolCall.name}" not found`,
        isError: true,
      },
    };
  }

  // 参数预处理
  const args = tool.prepareArguments
    ? tool.prepareArguments(toolCall.arguments)
    : toolCall.arguments;

  // 参数校验
  if (tool.validate) {
    const validation = tool.validate(args);
    if (!validation.valid) {
      return {
        kind: 'immediate',
        result: {
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: `Error: ${validation.error}`,
          isError: true,
        },
      };
    }
  }

  // beforeToolCall 回调
  if (beforeToolCall) {
    const beforeResult = await beforeToolCall(
      { toolCall, args, context },
      signal,
    );
    if (beforeResult?.block) {
      return {
        kind: 'immediate',
        result: {
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: beforeResult.reason ?? 'Tool execution blocked',
          isError: true,
          terminate: beforeResult.terminate,
        },
      };
    }
  }

  return { kind: 'prepared', tool, args };
}

// ── 工具函数 ──

/**
 * 规范化消息为 LLM 格式
 *
 * 处理内部 Message → LLMMessage 转换中的关键差异：
 * - 内部 Message.content 允许空字符串，但 LLM API 要求 assistant 消息
 *   必须有 content、reasoning_content 或 tool_calls 之一
 * - 有 tool_calls 时 content 必须是 null（非空字符串）
 */
function normalizeMessagesForLlm(messages: import('../core/types.js').Message[]): LLMMessage[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return messages.map((m: any) => {
    if (m.role !== 'assistant') return m;
    const hasToolCalls = m.toolCalls && m.toolCalls.length > 0;
    const hasContent = typeof m.content === 'string' && m.content.length > 0;
    if (hasToolCalls) {
      // 有 tool_calls: content 必须为 null（OpenAI API 要求）
      return { role: 'assistant', content: hasContent ? m.content : null,
        tool_calls: m.toolCalls.map((tc: any) => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments) },
        })),
      };
    }
    // 无 tool_calls: 保持原样（content 为空字符串也保留，不删除消息）
    return m;
  });
}

/**
 * 构建工具定义（ModelProvider 格式）
 */
function buildToolDefinitions(tools?: AgentTool[]): ModelToolDef[] {
  if (!tools) return [];
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }));
}
