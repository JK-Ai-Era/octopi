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
  ClassifiedError,
  LLMMessage,
  LLMStreamChunk,
  LoopEndReason,
  Message,
  ToolCall,
  ToolResult,
} from '../core/types.js';
import type { PluginManager } from '../plugins/manager.js';
import type { BeforeIterationResult } from '../plugins/manager.js';
import { IterationBudget } from './iteration-budget.js';
import {
  classifyError,
  isRetryable,
  jitteredBackoff,
} from './error-classifier.js';
import { createOutputQualityGate } from './output-quality-gate.js';
import { createOutputErrorClassifier } from './output-error-classifier.js';
import type { QualityGateConfig, RecoveryConfig } from './output-quality-types.js';

// ── 重复内容检测 ──

/**
 * 检测模型输出是否为重复内容
 *
 * 将文本按句子/标点分割，检查是否有大量重复片段。
 * 如果超过 60% 的片段是重复的，认为模型陷入循环。
 */
function isRepetitiveContent(text: string): boolean {
  if (text.length < 20) return false;

  // 按中文句号、感叹号、问号、换行分割
  const segments = text.split(/[。！？\n]+/).filter(s => s.trim().length > 2);
  if (segments.length < 3) return false;

  // 统计每个片段出现的次数
  const counts = new Map<string, number>();
  for (const seg of segments) {
    const key = seg.trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // 计算重复片段占比
  let repeatedCount = 0;
  for (const [, count] of counts) {
    if (count >= 2) repeatedCount += count;
  }

  return repeatedCount / segments.length > 0.6;
}

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
 * @param initialMessages - 初始消息列表（支持外部管理）
 * @param signal - 中止信号
 */
export async function* runAgentLoop(
  config: AgentLoopConfig,
  initialMessages: Message[],
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  const {
    provider,
    contextEngine,
    toolRegistry,
    messageConverter,
    pluginManager,
  } = config;

  const budget = new IterationBudget(config.iterationBudget);
  // 支持外部消息管理：如果传入数组，则使用外部消息列表
  // 直接使用传入的数组引用，允许外部管理（agent-runner 需要）
  // 如果传入单个消息，包装成数组
  const messages: Message[] = Array.isArray(initialMessages) ? initialMessages : [initialMessages];
  let turnIndex = 0;
  let consecutiveErrors = 0;
  let lastResponse: string | undefined;
  let loopEndReason: LoopEndReason = 'error';
  let loopEndResponse: string | undefined;
  
  // 输出质量异常历史（用于恢复策略决策）
  const qualityAnomalyHistory: Array<import('./output-quality-types.js').ErrorClassification> = [];

  // 构建 session ID（从第一条消息的 metadata 或生成）
  const firstMsg = Array.isArray(initialMessages) ? initialMessages[0] : initialMessages;
  const sessionId = (firstMsg?.metadata?.sessionId as string) ?? generateId('session');

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
      // Layer 1: LLM Decision (模型层)
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

      // 获取完整工具定义（OpenAI function calling 格式）
      const tools = config.toolRegistry.getDefinitions();
      const availableTools = (tools as Array<{function?: {name?: string}}>).map(t => t.function?.name ?? 'unknown');
      const assembleResult = await contextEngine.assemble({
        sessionId,
        messages: [...messages],
        tokenBudget: 100000, // 默认 token budget
        availableTools,
      });
      const llmMessages = assembleResult.messages as unknown as LLMMessage[];

      // ══════════════════════════════════════════
      // Plugin Hook: before_prompt_build（注入额外上下文）
      // ══════════════════════════════════════════
      if (pluginManager) {
        const buildResult = await pluginManager.runHook<{ prependContext?: string; prependSystemContext?: string } | null>(
          'before_prompt_build',
          {
            prompt: '', // 简化，实际 prompt 已在 llmMessages 里
            messages: [...messages],
            ctx: { sessionId, agentId: config.agentId },
          },
          null,
        );

        if (buildResult?.prependContext) {
          // 在最后一条 user 消息前插入额外上下文
          const lastUserIdx = llmMessages.map((m) => m.role).lastIndexOf('user');
          if (lastUserIdx >= 0) {
            llmMessages.splice(lastUserIdx, 0, {
              role: 'system',
              content: buildResult.prependContext,
            });
          }
        }

        if (buildResult?.prependSystemContext) {
          // 在 system prompt 前置追加
          const systemIdx = llmMessages.findIndex((m) => m.role === 'system');
          if (systemIdx >= 0) {
            llmMessages[systemIdx].content = buildResult.prependSystemContext + '\n\n' + (llmMessages[systemIdx].content ?? '');
          } else {
            llmMessages.unshift({ role: 'system', content: buildResult.prependSystemContext });
          }
        }
      }

      // 注入 skill 描述（不持久化，避免重复注入）
      if (config.skillManager) {
        const skillPromptFragment = config.skillManager.formatForPrompt();
        if (skillPromptFragment) {
          llmMessages.push({
            role: 'system',
            content: skillPromptFragment,
          });
        }
      }

      let model = config.defaultModel;

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
            thinking: undefined,
            sessionId,
            ctx: { sessionId, turnId, turnIndex },
          },
          null,
        );

        if (iterResult) {
          if (iterResult.model) model = iterResult.model;
          if (iterResult.thinking) {
            // thinking 由 plugin 控制，存储到 iterationPluginContext
          }
          if (iterResult.prependContext) iterationPluginContext = iterResult.prependContext;
          if (iterResult.stop) {
            yield { type: 'loop_end', reason: 'plugin_stop', response: iterResult.stopReason };
            return;
          }
        }
      }

      // 合并 iterationPluginContext + assembleResult.systemPromptAddition 到 system prompt
      const injectedContext = [iterationPluginContext, assembleResult.systemPromptAddition]
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
          tools, // ← 传入工具定义
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

      // ══════════════════════════════════════════
      // 重复内容检测（防止模型陷入输出循环）
      // ══════════════════════════════════════════

      if (!llmResponse.toolCalls?.length && isRepetitiveContent(llmResponse.content ?? '')) {
        yield {
          type: 'loop_end',
          reason: 'completed',
          response: llmResponse.content,
        } as any;
        return;
      }

      // ══════════════════════════════════════════
      // Output Quality Gate（输出质量检测）
      // ══════════════════════════════════════════
      
      if (config.outputQuality?.enabled) {
        const qualityGate = createOutputQualityGate();
        const classifier = createOutputErrorClassifier(config.recovery);
        
        const qualityResult = qualityGate.checkTextOutput(
          llmResponse.content ?? '',
          config.outputQuality
        );
        
        if (qualityResult.isAnomalous) {
          const classification = classifier.classify(qualityResult, {
            toolCalls: llmResponse.toolCalls,
            iterationCount: turnIndex,
            previousErrors: qualityAnomalyHistory,
          });
          
          // 发送异常事件
          yield {
            type: 'quality_anomaly',
            checkResult: qualityResult,
            classification,
            strategy: classification.recommendedStrategy,
          };
          
          // 根据策略执行恢复
          const recoveryConfig = config.recovery ?? {
            maxRetries: 2,
            fallbackModels: [],
            strategyPriority: {},
            degradeConfig: { disableTools: true },
          };
          
          // 检查是否还可以重试
          const sameTypeAnomalies = qualityAnomalyHistory.filter(
            e => e.type === classification.type
          );
          
          if (classification.recommendedStrategy === 'abort' ||
              sameTypeAnomalies.length >= recoveryConfig.maxRetries) {
            // 终止循环
            yield {
              type: 'loop_end',
              reason: 'error',
              response: 'Output quality anomaly detected: ' + classification.type,
            };
            return;
          }
          
          if (classification.recommendedStrategy === 'retry') {
            // 记录异常历史
            qualityAnomalyHistory.push(classification);
            
            // 清理当前迭代的 assistant 消息（不推入历史）
            // 重试当前迭代
            budget.refund();
            continue;
          }
          
          if (classification.recommendedStrategy === 'fallback' &&
              recoveryConfig.fallbackModels.length > 0) {
            // 切换到备用模型
            const fallbackModel = recoveryConfig.fallbackModels[0];
            if (fallbackModel) {
              // 记录异常历史
              qualityAnomalyHistory.push(classification);
              
              // 发送模型切换事件
              yield {
                type: 'model_change',
                model: fallbackModel,
                reason: 'quality_fallback',
              };
              
              // 更新模型并重试
              model = fallbackModel;
              budget.refund();
              continue;
            }
          }
          
          if (classification.recommendedStrategy === 'degrade') {
            // 降级模式：禁用工具，限制输出长度
            qualityAnomalyHistory.push(classification);
            
            yield {
              type: 'degrade_mode',
              reason: classification.type,
              config: recoveryConfig.degradeConfig,
            };
            
            // 下次迭代将使用降级配置（工具禁用等）
            // 这里先继续，后续迭代会检查降级状态
            budget.refund();
            continue;
          }
        }
      }

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

        // ══════════════════════════════════════════
        // Plugin Hook: before_tool_call (工具级，OpenClaw 标准)
        // ══════════════════════════════════════════
        if (pluginManager) {
          const blockResult = await pluginManager.runHook<{ block?: boolean } | null>(
            'before_tool_call',
            {
              toolName: tcName,
              params: JSON.parse(tcArgs || '{}'),
              call: { id: tcId, name: tcName, arguments: JSON.parse(tcArgs || '{}') },
              ctx: { sessionId, turnId, turnIndex },
            },
            null,
          );
          if (blockResult?.block) {
            yield {
              type: 'tool_call_result',
              toolCallId: tcId,
              toolName: tcName,
              result: 'Blocked by plugin',
              durationMs: 0,
            };

            // 工具结果加入消息
            const blockedMsg: Message = {
              role: 'tool',
              content: 'Blocked by plugin',
              timestamp: Date.now(),
              toolResults: [{
                toolCallId: tcId,
                name: tcName,
                result: null,
                error: 'Blocked by plugin',
                durationMs: 0,
              }],
            };
            messages.push(blockedMsg);
            toolResultsForTurn.push({
              toolCallId: tcId,
              name: tcName,
              result: null,
              error: 'Blocked by plugin',
              durationMs: 0,
            });
            continue; // 跳过实际执行
          }
        }

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
            parsedArgs, // 直接传 object
            {
              sessionId,
              turnId,
              abortSignal: signal,
              cwd: config.workspace, // ← 传递工作目录
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

          // ══════════════════════════════════════════
          // Plugin Hook: after_tool_call (工具级，OpenClaw 标准)
          // ══════════════════════════════════════════
          if (pluginManager) {
            await pluginManager.runAllHooks('after_tool_call', {
              call: { id: tcId, name: tcName, arguments: JSON.parse(tcArgs || '{}') },
              result: {
                toolCallId: tcId,
                name: tcName,
                result: result.result,
                error: result.error,
                durationMs,
              },
              ctx: { sessionId, turnId, turnIndex },
            });
          }
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
      yield { type: 'turn_end', turnId, shouldContinue: true };

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
          messages.push(...steeringMsgs);
          yield {
            type: 'messages_injected',
            count: steeringMsgs.length,
            source: 'steering',
          };
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
  tools: unknown[], // ← 工具定义
  signal: AbortSignal | undefined,
  onDelta: (chunk: LLMStreamChunk) => void,
  retryConfig: { maxRetries: number; baseDelayMs: number; maxDelayMs: number },
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
          tools, // ← 包含工具定义
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
            // 处理 provider 返回的 toolCalls（可能是 ToolCall 或 LLMToolCallRaw 格式）
            toolCalls = chunk.toolCalls.map((tc: any) => {
              // 如果是 ToolCall 格式（id, name, arguments）
              if (tc.name && !tc.function) {
                return {
                  id: tc.id,
                  type: 'function' as const,
                  function: {
                    name: tc.name,
                    arguments: typeof tc.arguments === 'object' ? JSON.stringify(tc.arguments) : (tc.arguments ?? '{}'),
                  },
                };
              }
              // 已经是 LLMToolCallRaw 格式
              return tc;
            });
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
        tools, // ← 包含工具定义
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
