/**
 * 模型调用 — Watchdog 模式流式调用
 *
 * 职责：
 * - 包装 provider.stream，添加引擎层超时保护
 * - 逐 chunk yield 流式事件（llm_stream_delta）
 * - 流失败时 fallback 到同步调用（同步调用同样受 watchdog 保护）
 *
 * 职责分离：
 * - Provider: HTTP 连接健康（connect timeout + idle timeout）
 * - Engine: 响应性保障（watchdog: idle timeout + abort）
 *
 * 取消语义：放弃流式时会 abort 传给 provider 的 AbortSignal。
 * 仅 `generator.return()` 打断不了挂起的 `reader.read()`，底层 fetch 会悬挂。
 */

import type { Message, ToolCall, TokenUsage } from '../core/types.js';
import type {
  ModelProvider,
  LLMMessage,
  LLMResponse,
  LLMStreamChunk,
  LLMToolDefinition,
} from '../core/interfaces/model-provider.js';
import type { AgentLoopEvent } from './types.js';

/**
 * 调用模型（watchdog 模式，async generator）
 *
 * 竞争三个信号：provider chunk / idle timeout / abort signal。
 * 逐 chunk yield llm_stream_delta 事件。
 * 返回最终的 LLMResponse。
 */
export async function* callModel(
  model: ModelProvider,
  messages: LLMMessage[],
  tools: LLMToolDefinition[],
  signal: AbortSignal | undefined,
  timeouts: { idleTimeoutMs: number; absoluteTimeoutMs: number },
): AsyncGenerator<AgentLoopEvent, LLMResponse> {
  const { idleTimeoutMs, absoluteTimeoutMs } = timeouts;
  const requestStartTime = Date.now();

  let content = '';
  const toolCallBuffers = new Map<number, { id: string; name: string; argsBuffer: string }>();
  let usage: TokenUsage | undefined;
  let finishReason: LLMResponse['finishReason'] | undefined;

  const remainingAbsoluteMs = () => absoluteTimeoutMs - (Date.now() - requestStartTime);

  /**
   * 同步 fallback 预算：至少一个 idle 窗口；剩余绝对预算更大时用更大的。
   * 保证 chat() 不会在无引擎超时的情况下干等对端断连。
   */
  const syncBudgetMs = () => {
    const remaining = remainingAbsoluteMs();
    return remaining > 0 ? Math.max(idleTimeoutMs, remaining) : idleTimeoutMs;
  };

  const runChatWithWatchdog = async (): Promise<LLMResponse> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Model call sync timeout: no response from provider within timeout window'));
      }, syncBudgetMs());
      const onAbort = () => reject(new Error('Aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });

      model.chat({ messages, tools, signal, model: model.defaultModel }).then(
        (response) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (!response) {
            reject(new Error('model.chat() returned undefined — provider may be misconfigured'));
            return;
          }
          resolve(response);
        },
        (err) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  };

  const fallbackToSync = async function* (
    reason: string,
  ): AsyncGenerator<AgentLoopEvent, LLMResponse> {
    yield {
      type: 'stream.fallback_to_sync',
      timestamp: Date.now(),
      data: { reason },
    };
    try {
      const response = await runChatWithWatchdog();
      if (response.content) {
        yield { type: 'llm_stream_delta', timestamp: Date.now(), data: { delta: response.content } };
      }
      return response;
    } catch (syncErr) {
      yield {
        type: 'stream.fallback_failed',
        timestamp: Date.now(),
        data: { error: syncErr instanceof Error ? syncErr.message : String(syncErr) },
      };
      throw syncErr;
    }
  };

  // 独立 AbortController：放弃流式时真正取消 provider HTTP，而不是只 return() generator
  const streamAbort = new AbortController();
  const onParentAbort = () => streamAbort.abort();
  if (signal?.aborted) {
    streamAbort.abort();
  } else {
    signal?.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    try {
      // 显式带上 defaultModel，避免 provider 只依赖自身字段而忽略包装层注入
      const providerStream = model.stream({
        messages,
        tools,
        signal: streamAbort.signal,
        model: model.defaultModel,
      });
      let idleTimer: ReturnType<typeof setTimeout> | null = null;

      // Watchdog: 竞争 provider chunk / idle timeout / abort signal
      const watchdogRead = (): Promise<IteratorResult<LLMStreamChunk>> => {
        return new Promise((resolve, reject) => {
          const absRemaining = remainingAbsoluteMs();
          const effectiveTimeout = Math.max(0, Math.min(idleTimeoutMs, absRemaining));

          if (effectiveTimeout === 0) {
            reject(new Error('Model call absolute timeout: total request time exceeded limit'));
            return;
          }

          idleTimer = setTimeout(() => {
            reject(new Error('Model call idle timeout: no data received from provider within timeout window'));
          }, effectiveTimeout);

          const onAbort = () => reject(new Error('Aborted'));
          streamAbort.signal.addEventListener('abort', onAbort, { once: true });

          providerStream.next().then(
            (result) => {
              if (idleTimer) clearTimeout(idleTimer);
              streamAbort.signal.removeEventListener('abort', onAbort);
              resolve(result);
            },
            (err) => {
              if (idleTimer) clearTimeout(idleTimer);
              streamAbort.signal.removeEventListener('abort', onAbort);
              reject(err);
            },
          );
        });
      };

      try {
        while (true) {
          const { done, value: chunk } = await watchdogRead();
          if (done) break;

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
            usage = chunk.usage;
            if (chunk.finishReason) finishReason = chunk.finishReason;
          }

          if (chunk.type === 'error') {
            throw new Error(chunk.error ?? 'Stream error');
          }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        // Abort 底层 HTTP：仅 return() 打断不了挂起的 reader.read()
        streamAbort.abort();
        void providerStream.return?.(undefined as never)?.catch(() => undefined);
      }
    } catch (err) {
      // 用户/引擎中止时不要启动同步 fallback（避免 abort 后又发起新请求）
      if (signal?.aborted) {
        throw err;
      }
      return yield* fallbackToSync(err instanceof Error ? err.message : 'stream_error');
    }

    // 流正常结束但内容为空且无工具调用 → fallback 到同步调用
    if (!content && toolCallBuffers.size === 0) {
      return yield* fallbackToSync('empty_stream');
    }
  } finally {
    signal?.removeEventListener('abort', onParentAbort);
  }

  // 组装最终 LLMResponse
  const toolCalls: ToolCall[] = [];
  for (const [, buf] of toolCallBuffers) {
    let args: Record<string, unknown> = {};
    let parseError: string | undefined;
    const raw = buf.argsBuffer ?? '';
    if (raw.trim().length > 0) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        } else {
          parseError = `Tool arguments must be a JSON object, got: ${raw.slice(0, 200)}`;
        }
      } catch {
        parseError = `Invalid JSON in tool arguments: ${raw.slice(0, 200)}`;
      }
    }
    toolCalls.push({
      id: buf.id,
      name: buf.name,
      arguments: args,
      ...(parseError ? { argumentsParseError: parseError } : {}),
    });
  }

  // 优先使用 provider 透传的 finishReason；缺失时按是否有 tool_calls 合成
  const resolvedFinishReason: LLMResponse['finishReason'] =
    finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop');

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
    model: typeof model.defaultModel === 'string' ? model.defaultModel : 'unknown',
    finishReason: resolvedFinishReason,
  };
}
