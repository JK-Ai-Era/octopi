/**
 * 模型调用 — Watchdog 模式流式调用
 *
 * 职责：
 * - 包装 provider.stream，添加引擎层超时保护
 * - 逐 chunk yield 流式事件（llm_stream_delta）
 * - 流失败时 fallback 到同步调用
 *
 * 职责分离：
 * - Provider: HTTP 连接健康（connect timeout + idle timeout）
 * - Engine: 响应性保障（watchdog: idle timeout + abort）
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

  try {
    // 显式带上 defaultModel，避免 provider 只依赖自身字段而忽略包装层注入
    const providerStream = model.stream({
      messages,
      tools,
      signal,
      model: model.defaultModel,
    });
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const remainingAbsoluteMs = () => absoluteTimeoutMs - (Date.now() - requestStartTime);

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
        signal?.addEventListener('abort', onAbort, { once: true });

        providerStream.next().then(
          (result) => {
            if (idleTimer) clearTimeout(idleTimer);
            signal?.removeEventListener('abort', onAbort);
            resolve(result);
          },
          (err) => {
            if (idleTimer) clearTimeout(idleTimer);
            signal?.removeEventListener('abort', onAbort);
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
      // 尽力释放底层 generator，避免超时/中止后连接悬挂
      void providerStream.return?.(undefined as never)?.catch(() => undefined);
    }
  } catch (err) {
    // 流失败 → fallback 到同步调用
    yield {
      type: 'stream.fallback_to_sync',
      timestamp: Date.now(),
      data: { reason: err instanceof Error ? err.message : 'stream_error' },
    };
    try {
      const response = await model.chat({
        messages,
        tools,
        signal,
        model: model.defaultModel,
      });
      if (!response) {
        throw new Error('model.chat() returned undefined — provider may be misconfigured');
      }
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
  }

  // 流正常结束但内容为空且无工具调用 → fallback 到同步调用
  if (!content && toolCallBuffers.size === 0) {
    yield {
      type: 'stream.fallback_to_sync',
      timestamp: Date.now(),
      data: { reason: 'empty_stream' },
    };
    try {
      const response = await model.chat({
        messages,
        tools,
        signal,
        model: model.defaultModel,
      });
      if (!response) {
        throw new Error('model.chat() returned undefined — provider may be misconfigured');
      }
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
