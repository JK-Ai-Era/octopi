/**
 * Agent 核心循环 — 纯函数
 *
 * 职责：调用 LLM → 解析响应 → 执行工具 → 循环
 * 不持有状态，不依赖外部组件实例。
 *
 * 不包含：重试逻辑、消息注入、循环检测、no-op 检测。
 * 这些机制由 Harness 层通过回调和外部循环实现。
 *
 * 错误契约：LLM 业务失败经 onError 决策为 retry/abort，永不 throw；
 * 终止时一律 yield agent_end，保证事件消费方总能看到终态。
 *
 * 流式输出：通过 callModel() 的 async generator 逐 chunk yield llm_stream_delta。
 */

import type { Message, ToolCall, TokenUsage } from '../core/types.js';
import type { LLMMessage, LLMResponse, LLMToolDefinition } from '../core/interfaces/model-provider.js';
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
 * @param context - 上下文工作区（循环内**原地**修改 messages）
 * @param config - 循环配置（模型 + 回调 + 超时）
 * @param signal - 中止信号
 * @yields AgentLoopEvent 事件流（协议事件；不含 budget/run_guard）
 * @returns void — 终止原因通过 `agent_end` 事件表达；完整历史读 `context.messages`
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

  // systemPrompt 是引擎托管 system 消息的权威来源。
  // 不变量：托管 system 至多一条，且在 index 0。
  // 仅管理 metadata.source === 'systemPrompt' 的消息；无 metadata / 外部 system
  // 一律保留，避免静默删掉用户或历史导入的 system。
  {
    const isManaged = (m: { role: string; metadata?: Record<string, unknown> }): boolean =>
      m.role === 'system' && m.metadata?.source === 'systemPrompt';

    const managedIndices: number[] = [];
    for (let i = 0; i < context.messages.length; i++) {
      if (isManaged(context.messages[i])) managedIndices.push(i);
    }

    if (context.systemPrompt) {
      const managedMsg = {
        role: 'system' as const,
        content: context.systemPrompt,
        timestamp: Date.now(),
        metadata: { source: 'systemPrompt' as const },
      };
      if (managedIndices.length === 0) {
        context.messages.unshift(managedMsg);
      } else {
        // 只保留首条 managed：内容未变则原地不动（避免 timestamp 抖动）
        const firstIdx = managedIndices[0];
        const existing = context.messages[firstIdx];
        if (existing.content !== context.systemPrompt || existing.metadata?.source !== 'systemPrompt') {
          context.messages[firstIdx] = { ...managedMsg };
        }
        // 删除其余 managed（历史脏数据 / 重复注入）
        for (let n = managedIndices.length - 1; n >= 1; n--) {
          context.messages.splice(managedIndices[n], 1);
        }
        // 托管 system 固定在 index 0
        if (firstIdx !== 0) {
          const [msg] = context.messages.splice(firstIdx, 1);
          context.messages.unshift(msg);
        }
      }
    } else {
      // 热删除 / 清空 persona：摘除全部托管 system
      for (let n = managedIndices.length - 1; n >= 0; n--) {
        context.messages.splice(managedIndices[n], 1);
      }
    }
  }

  // 当前上下文（循环内直接修改 messages 引用）
  let currentContext = context;
  let currentModel = model;
  // 最近一次 LLM 调用的 usage。每次调用发送完整上下文，所以最新值即为当前上下文大小。
  // 注意：不应累加 reported prompt（那会变成输入 token 总消耗，而非上下文大小）。
  let lastResponseUsage: TokenUsage | undefined;

  // 已中止：不发 agent_start，直接终态
  if (signal?.aborted) {
    yield { type: 'agent_end', reason: 'aborted', timestamp: Date.now() };
    return;
  }

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
      // 不变量：业务错误永不 throw，始终以 agent_end 终态事件结束，保证用户可见
      const classified = classifyError(llmError);
      if (onError) {
        const action = await onError(classified);
        if (action === 'retry') {
          yield { type: 'turn_end', hasToolCalls: false, phase: 'final', error: true, usage: lastResponseUsage };
          continue; // 重试当前迭代
        }
        // action === 'abort'
      }
      // abort / 无 onError：yield 终态事件后干净退出（不抛）
      yield { type: 'agent_end', reason: 'error', timestamp: Date.now(), error: llmError };
      return;
    }

    observer?.onLLMEnd?.({ model: currentModel.name, usage: response.usage });
    lastResponseUsage = response.usage;

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
          const tc = response.toolCalls.find(t => t.id === er.toolCallId)
            ?? { id: er.toolCallId, name: er.name, arguments: {} };
          yield { type: 'tool_end', toolCall: tc, result: er, timestamp: Date.now() };
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
            yield { type: 'turn_end', hasToolCalls: true, phase: 'final', truncated: true, usage: lastResponseUsage };
            yield { type: 'agent_end', reason: 'should_stop', timestamp: Date.now() };
            return;
          }
        }

        yield { type: 'turn_end', hasToolCalls: true, phase: 'final', truncated: true, usage: lastResponseUsage };
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
          yield { type: 'turn_end', hasToolCalls: false, phase: 'final', usage: lastResponseUsage };
          yield { type: 'agent_end', reason: 'should_stop', timestamp: Date.now() };
          return;
        }
      }

      // 检查 followUp 消息队列
      const followUps = getFollowUpMessages ? await getFollowUpMessages() : [];
      if (followUps.length > 0) {
        currentContext.messages.push(...followUps);
        yield { type: 'turn_end', hasToolCalls: false, phase: 'final', usage: lastResponseUsage };
        continue;
      }

      // 无工具调用 + 无 followUp → 自然结束
      yield { type: 'turn_end', hasToolCalls: false, phase: 'final', usage: lastResponseUsage };
      yield { type: 'agent_end', reason: 'completed', timestamp: Date.now() };
      return;
    }

    // ── 7. 执行工具 ──
    // pre_tools：本轮 LLM 结束且 tool_calls 已入历史；工具即将执行。
    // 消费方勿把 pre_tools 当成「turn 已完整结束」。
    yield { type: 'turn_end', hasToolCalls: true, phase: 'pre_tools', usage: lastResponseUsage };

    // 7a. 为每个工具调用发出 tool_start 事件
    for (const tc of toolCalls) {
      yield { type: 'tool_start', toolCall: tc, timestamp: Date.now() };
    }

    // 7b. 执行工具，每个完成后立即 yield tool_end（避免全部跑完才更新 UI）
    const toolCallById = new Map(toolCalls.map(tc => [tc.id, tc]));
    const toolResults: LoopToolResult[] = [];
    const hasSequentialTool = toolCalls.some(
      (tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === 'sequential',
    );

    if (toolExecution === 'sequential' || hasSequentialTool) {
      // 串行：逐个执行，每个完成后立即 yield
      for (const tc of toolCalls) {
        let result: LoopToolResult;
        if (signal?.aborted) {
          result = {
            toolCallId: tc.id,
            name: tc.name,
            content: 'Error: Agent aborted before tool execution',
            isError: true,
            durationMs: 0,
          };
        } else {
          result = await executeOneTool(tc, currentContext, beforeToolCall, afterToolCall, observer, signal);
        }
        toolResults.push(result);
        yield { type: 'tool_end', toolCall: tc, result, timestamp: Date.now() };
      }
    } else {
      // 并行：先串行 prepare，再并行 execute，每个完成立即 yield。
      // afterToolCall 按完成序执行（非 toolCalls 序）；SecurityGuard 等无序副作用不受影响。
      // 若 afterToolCall 依赖工具调用顺序写共享状态，请改用 sequential 模式。
      const prepared: Array<
        | { kind: 'prepared'; toolCall: ToolCall; tool: AgentTool; args: unknown }
        | { kind: 'immediate'; toolCall: ToolCall; result: LoopToolResult }
      > = [];
      for (const tc of toolCalls) {
        const prep = await prepareToolCall(tc, currentContext, beforeToolCall, signal);
        if (prep.kind === 'immediate') {
          prepared.push({ kind: 'immediate', toolCall: tc, result: prep.result });
        } else {
          prepared.push({ kind: 'prepared', toolCall: tc, tool: prep.tool, args: prep.args });
        }
      }

      // 启动全部执行，用带 tag 的 Promise.race 逐个收割
      const pending = new Map<string, Promise<{ id: string; result: LoopToolResult }>>();
      for (const p of prepared) {
        if (p.kind === 'immediate') {
          pending.set(p.toolCall.id, Promise.resolve({ id: p.toolCall.id, result: p.result }));
          continue;
        }
        pending.set(p.toolCall.id, (async () => {
          const startTime = Date.now();
          try {
            // observer 异常不应导致 promise reject（否则 Promise.race 会中断收割循环）
            try { observer?.onToolStart?.({ toolCall: p.toolCall }); } catch { /* observer 异常不中断工具执行 */ }
            const result = await p.tool.execute(p.toolCall.id, p.args, signal);
            return { id: p.toolCall.id, result: { ...result, durationMs: Date.now() - startTime } };
          } catch (error) {
            return {
              id: p.toolCall.id,
              result: {
                toolCallId: p.toolCall.id,
                name: p.toolCall.name,
                content: `Error: ${error instanceof Error ? error.message : String(error)}`,
                isError: true,
                durationMs: Date.now() - startTime,
              } satisfies LoopToolResult,
            };
          }
        })());
      }

      const completed = new Map<string, LoopToolResult>();
      while (pending.size > 0) {
        const { id, result: rawResult } = await Promise.race(pending.values());
        pending.delete(id);

        // afterToolCall 必须在 yield 之前：SecurityGuard 出口检查会改写 result，
        // 事件面（WS/UI/EventBus）必须拿到脱敏后的结果，与串行路径契约一致。
        // afterToolCall 抛异常时降级为错误结果，不中断收割循环（保证 agent_end 契约）。
        let result = rawResult;
        if (afterToolCall && !result.isError) {
          const prepEntry = prepared.find(p => p.toolCall.id === id);
          try {
            const afterResult = await afterToolCall(
              { toolCall: toolCallById.get(id)!, args: prepEntry?.kind === 'prepared' ? prepEntry.args : undefined, result, context: currentContext },
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
          } catch (afterError) {
            result = {
              ...result,
              content: `Error in afterToolCall: ${afterError instanceof Error ? afterError.message : String(afterError)}`,
              isError: true,
            };
          }
        }

        completed.set(id, result);
        // observer 在 afterToolCall 之后触发，确保 trace/metrics 拿到脱敏后结果。
        // immediate（工具不存在 / 参数失败 / beforeToolCall.block）从未 onToolStart，
        // 也不应 onToolEnd，保持 start/end 配对。
        const prepEntry = prepared.find(p => p.toolCall.id === id);
        if (prepEntry?.kind !== 'immediate') {
          try { observer?.onToolEnd?.({ toolCall: toolCallById.get(id)!, result }); } catch { /* observer 异常不中断 */ }
        }
        const tc = toolCallById.get(id) ?? { id, name: result.name, arguments: {} };
        yield { type: 'tool_end', toolCall: tc, result, timestamp: Date.now() };
      }

      // 按 toolCalls 原序组装 toolResults（保证与历史 tool_calls 一一对应）
      for (const tc of toolCalls) {
        toolResults.push(completed.get(tc.id)!);
      }
    }

    // 将工具结果加入消息历史（一次 push，使用 toolResults 数组）
    // 不变量：toolResults 与 toolCalls 一一对应（含中止占位）
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

    // terminate：批次内所有结果要求停止 → 干净结束
    // （预算 hard / HITL 等通过 beforeToolCall.block + terminate 注入）
    if (toolResults.length > 0 && toolResults.every(r => r.terminate)) {
      yield { type: 'agent_end', reason: 'should_stop', timestamp: Date.now() };
      return;
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
    // 不变量：不得替换 Agent 持有的 context 对象引用；只允许改字段 / 换 model。
    if (prepareNextTurn) {
      const update = await prepareNextTurn({ message: assistantMessage, toolResults, context: currentContext });
      if (update) {
        if (update.model) currentModel = update.model;
        if (update.context && update.context !== currentContext) {
          currentContext.systemPrompt = update.context.systemPrompt;
          currentContext.messages = update.context.messages;
          currentContext.tools = update.context.tools;
        }
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
  try { observer?.onToolStart?.({ toolCall }); } catch { /* observer 异常不中断工具执行 */ }
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

  // afterToolCall 抛异常时降级为错误结果，不中断循环
  if (afterToolCall && !result.isError) {
    try {
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
    } catch (afterError) {
      result = {
        ...result,
        content: `Error in afterToolCall: ${afterError instanceof Error ? afterError.message : String(afterError)}`,
        isError: true,
      };
    }
  }

  // observer 在 afterToolCall 之后触发，确保 trace/metrics 拿到脱敏后结果
  try { observer?.onToolEnd?.({ toolCall, result }); } catch { /* observer 异常不中断 */ }

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

  // LLM 返回的 arguments 不是合法 JSON：拒绝执行，避免空参数误伤
  if (toolCall.argumentsParseError) {
    return {
      kind: 'immediate',
      result: {
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: `Error: ${toolCall.argumentsParseError}`,
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
 * 规范化消息为 LLM 格式（ModelProvider 边界）
 *
 * 不变量：进入 chat/stream 的 messages 必须是干净的 LLMMessage[]：
 * - assistant + tool_calls → OpenAI 形状（arguments 字符串化；无 content 则为 null）
 * - tool + toolResults[N] → **N 条**独立 tool 消息（tool_call_id / content）
 * - system / user / multimodal content 原样透传
 *
 * Provider 侧 flatten 仅作防御兼容，主路径不再依赖。
 */
function normalizeMessagesForLlm(messages: import('../core/types.js').Message[]): LLMMessage[] {
  const out: LLMMessage[] = [];

  for (const m of messages) {
    if (m.role === 'tool' && Array.isArray(m.toolResults) && m.toolResults.length > 0) {
      for (const tr of m.toolResults) {
        const content =
          tr.error !== undefined
            ? JSON.stringify({ error: tr.error })
            : typeof tr.result === 'string'
              ? tr.result
              : JSON.stringify(tr.result ?? null);
        out.push({
          role: 'tool',
          tool_call_id: tr.toolCallId,
          name: tr.name,
          content,
        });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const hasToolCalls = Boolean(m.toolCalls && m.toolCalls.length > 0);
      const hasContent = typeof m.content === 'string' && m.content.length > 0;
      if (hasToolCalls) {
        out.push({
          role: 'assistant',
          content: hasContent && typeof m.content === 'string' ? m.content : null,
          tool_calls: m.toolCalls!.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments:
                typeof tc.arguments === 'string'
                  ? tc.arguments
                  : JSON.stringify(tc.arguments ?? {}),
            },
          })),
        });
        continue;
      }
      out.push({
        role: 'assistant',
        content: m.content as LLMMessage['content'],
      });
      continue;
    }

    // system / user（含多模态 content blocks）
    out.push({
      role: m.role,
      content: m.content as LLMMessage['content'],
    });
  }

  return out;
}

/**
 * 构建工具定义（ModelProvider 格式）
 */
function buildToolDefinitions(tools?: AgentTool[]): LLMToolDefinition[] {
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
