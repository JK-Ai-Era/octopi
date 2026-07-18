/**
 * OpenAI 兼容 LLM Provider
 *
 * 支持所有 OpenAI 兼容 API（OpenAI、Azure OpenAI、各种代理等）。
 * 通过 baseUrl 配置可以指向任何兼容端点。
 *
 * 实现 ModelProvider 接口，支持同步和流式调用。
 *
 * 使用方式：
 * ```ts
 * const provider = new OpenAIProvider({
 *   name: 'openai',
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   baseUrl: 'https://api.openai.com/v1',
 *   models: ['gpt-5.5', 'gpt-5.5-mini'],
 * });
 * ```
 */

import type {
  ModelProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from '../../core/interfaces/model-provider.js';
import type { ToolCall, ModelInfo } from '../../core/types.js';
import { mergeWithBuiltinInfo } from '../../builtin-model-info.js';

/**
 * OpenAI Provider 配置
 */
export interface OpenAIProviderConfig {
  /** Provider 名称 */
  name?: string;
  /** API Key */
  apiKey: string;
  /** API Base URL（默认 https://api.openai.com/v1） */
  baseUrl?: string;
  /**
   * 支持的模型列表
   *
   * 两种形式：
   * - string: 只有模型名称
   * - ModelInfo: 名称 + 能力声明（contextWindow, maxOutputTokens）
   */
  models?: (string | ModelInfo)[];
  /** 默认使用的模型 */
  defaultModel?: string;
  /** 请求超时（毫秒） */
  timeoutMs?: number;
}

/**
 * OpenAI 兼容 LLM Provider
 *
 * 实现 ModelProvider 接口。
 */
export class OpenAIProvider implements ModelProvider {
  readonly name: string;
  readonly models: string[];
  private modelInfoMap: Map<string, ModelInfo> = new Map();
  private apiKey: string;
  private baseUrl: string;
  readonly defaultModel: string;
  private timeoutMs: number;

  constructor(config: OpenAIProviderConfig) {
    this.name = config.name ?? 'openai';
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? 60_000;

    // 解析 models 配置：提取名称列表 + ModelInfo 映射
    // 合并内置默认值（用户配置优先）
    const rawModels = config.models ?? ['gpt-5.5', 'gpt-5.5-mini'];
    this.models = [];
    for (const entry of rawModels) {
      if (typeof entry === 'string') {
        this.models.push(entry);
        const builtin = mergeWithBuiltinInfo(entry);
        if (builtin) this.modelInfoMap.set(entry, builtin);
      } else {
        this.models.push(entry.name);
        const merged = mergeWithBuiltinInfo(entry.name, entry);
        if (merged) this.modelInfoMap.set(entry.name, merged);
      }
    }

    this.defaultModel = config.defaultModel ?? this.models[0];
  }

  /**
   * 查询模型能力声明
   *
   * 返回 ModelInfo（contextWindow, maxOutputTokens）或 null（未配置）。
   */
  getModelInfo(modelName: string): ModelInfo | null {
    return this.modelInfoMap.get(modelName) ?? null;
  }

  getModelInfos(): ModelInfo[] {
    return Array.from(this.modelInfoMap.values());
  }

  /**
   * 同步调用 LLM
   */
  async chat(request: LLMRequest): Promise<LLMResponse> {
    const body = this.buildRequestBody(request);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // 合并外部 signal（engine 中止）和超时 signal
    if (request.signal) {
      if (request.signal.aborted) {
        clearTimeout(timer);
        throw new Error('Request aborted');
      }
      request.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown error');
        throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
      }

      const data = await response.json() as any;
      return this.parseResponse(data);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 流式调用 LLM
   *
   * 返回 AsyncGenerator<LLMStreamChunk>，逐步产出内容。
   */
  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
    const body = { ...this.buildRequestBody(request), stream: true };

    const controller = new AbortController();

    // 合并外部 signal（engine 中止）和超时 signal
    if (request.signal) {
      if (request.signal.aborted) throw new Error('Request aborted');
      request.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    // 连接超时：fetch 建立连接的最大等待时间
    const connectTimer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(connectTimer);
      throw err;
    }
    // 连接已建立，清除连接超时
    clearTimeout(connectTimer);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    // 空闲超时：如果服务端在 timeoutMs 内没有发送数据，中断读取
    const streamIdleTimeout = this.timeoutMs;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), streamIdleTimeout);
    };
    resetIdleTimer();

    // tool_calls 拼接 buffer（index → {id, name, argsBuffer}）
    const toolCallBuffers = new Map<number, { id: string; name: string; argsBuffer: string }>();

    try {
    while (true) {
      const readPromise = reader.read();
      const { done, value } = await readPromise;
      if (done) break;
      resetIdleTimer();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          // 流结束：输出 tool_calls（如果有）
          if (toolCallBuffers.size > 0) {
            for (const [idx, buf] of toolCallBuffers) {
              yield {
                type: 'tool_call',
                toolCall: {
                  id: buf.id,
                  name: buf.name,
                  arguments: buf.argsBuffer,
                  index: idx,
                },
              };
            }
          }
          yield { type: 'done' };
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          // 文本内容：增量输出
          if (delta.content) {
            yield { type: 'content', content: delta.content };
          }

          // reasoning 输出（Ollama 特有）
          if (delta.reasoning) {
            yield { type: 'content', content: delta.reasoning };
          }

          // tool_calls：增量拼接到 buffer
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCallBuffers.get(idx);
              if (existing) {
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.argsBuffer += tc.function.arguments;
              } else {
                toolCallBuffers.set(idx, {
                  id: tc.id ?? `call_${idx}`,
                  name: tc.function?.name ?? '',
                  argsBuffer: tc.function?.arguments ?? '',
                });
              }
            }
          }
        } catch {
          // 忽略解析错误
        }
      }
    }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  /**
   * 检查 provider 是否可用
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ================================================================
  // 内部方法
  // ================================================================

  /**
   * 构建 OpenAI API 请求体
   */
  private buildRequestBody(request: LLMRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      messages: this.flattenMessages(request.messages).map((msg) => this.sanitizeMessage(msg)),
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    // maxTokens: 请求值与模型能力取较小值
    const modelInfo = this.modelInfoMap.get(body.model as string);
    const cap = modelInfo?.maxOutputTokens;
    if (request.maxTokens !== undefined) {
      body.max_tokens = cap ? Math.min(request.maxTokens, cap) : request.maxTokens;
    } else if (cap) {
      body.max_tokens = cap;
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
    }

    return body;
  }

  /**
   * 净化消息：只保留 OpenAI API 所需字段
   *
   * 注意：引擎的 tool 消息格式是 { role: 'tool', toolResults: [...] }，
   * 但 OpenAI API 需要每个 tool result 作为独立的消息。
   * 此方法将 toolResults 展开为多条消息（调用方需展平）。
   */
  private sanitizeMessage(msg: any): any {
    // 规范化 content：空字符串转 null（OpenAI API 规范）
    // 当 assistant 消息有 tool_calls 时，content 应为 null 而非空字符串
    // 空字符串可能导致某些模型行为异常（如 mimo-v2.5 持续返回 tool_calls）
    let content = msg.content ?? null;
    if (content === '') content = null;

    const clean: any = {
      role: msg.role,
      content,
    };

    // assistant 消息：保留 tool_calls
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      clean.tool_calls = msg.tool_calls;
    }

    // tool 消息：必须有 tool_call_id（由 flattenMessages 保证）
    if (msg.role === 'tool') {
      if (msg.tool_call_id) clean.tool_call_id = msg.tool_call_id;
      if (msg.name) clean.name = msg.name;
    }

    return clean;
  }

  /**
   * 展平消息列表：将引擎格式的 tool 消息展开为 OpenAI API 格式
   *
   * 引擎格式：{ role: 'tool', toolResults: [r1, r2, ...] }
   * API 格式：[{ role: 'tool', tool_call_id: r1.id, content: ... }, { role: 'tool', tool_call_id: r2.id, ... }]
   *
   * 单条 tool result 也会被展开，确保格式一致。
   */
  private flattenMessages(messages: any[]): any[] {
    const result: any[] = [];
    for (const msg of messages) {
      if (msg.role === 'tool' && Array.isArray(msg.toolResults) && msg.toolResults.length > 0) {
        // 展开每条 tool result 为独立消息
        for (const tr of msg.toolResults) {
          result.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            name: tr.name,
            content: tr.error
              ? JSON.stringify({ error: tr.error })
              : (typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result ?? null)),
          });
        }
      } else {
        result.push(msg);
      }
    }
    return result;
  }

  /**
   * 解析 OpenAI API 响应
   */
  private parseResponse(data: any): LLMResponse {
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error('No choices in response');
    }

    const message = choice.message;
    const toolCalls = message.tool_calls ? this.parseToolCalls(message.tool_calls) : undefined;

    return {
      content: message.content ?? '',
      toolCalls,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: data.model ?? 'unknown',
      finishReason: this.mapFinishReason(choice.finish_reason),
    };
  }

  /**
   * 解析 tool_calls
   */
  private parseToolCalls(calls: any[]): ToolCall[] {
    return calls.map((call, i) => {
      const fn = call.function ?? call;
      return {
        id: call.id ?? `call_${i}`,
        name: fn.name,
        arguments: typeof fn.arguments === 'string'
          ? (() => { try { return JSON.parse(fn.arguments); } catch { return {}; } })()
          : (fn.arguments ?? {}),
      };
    });
  }

  /**
   * 映射 finish_reason
   */
  private mapFinishReason(reason: string): LLMResponse['finishReason'] {
    switch (reason) {
      case 'stop': return 'stop';
      case 'tool_calls': return 'tool_calls';
      case 'length': return 'length';
      default: return 'error';
    }
  }
}
