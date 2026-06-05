/**
 * OpenAI 兼容 LLM Provider
 *
 * 支持所有 OpenAI 兼容 API（OpenAI、Azure OpenAI、各种代理等）。
 * 通过 baseUrl 配置可以指向任何兼容端点。
 *
 * 支持的功能：
 * - 同步调用（complete）
 * - 流式调用（stream）
 * - Function calling（tool_calls）
 * - 健康检查
 *
 * 使用方式：
 * ```ts
 * const provider = new OpenAIProvider({
 *   name: 'openai',
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   baseUrl: 'https://api.openai.com/v1',
 *   models: ['gpt-4o', 'gpt-4o-mini'],
 * });
 * ```
 */

import type { LLMProvider, LLMRequest, LLMResponse, ToolCall, TokenUsage } from '../core/types.js';

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
  /** 支持的模型列表 */
  models?: string[];
  /** 默认使用的模型 */
  defaultModel?: string;
  /** 请求超时（毫秒） */
  timeoutMs?: number;
}

/**
 * OpenAI 兼容 LLM Provider
 */
export class OpenAIProvider implements LLMProvider {
  name: string;
  models: string[];
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private timeoutMs: number;

  constructor(config: OpenAIProviderConfig) {
    this.name = config.name ?? 'openai';
    this.models = config.models ?? ['gpt-4o', 'gpt-4o-mini'];
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.defaultModel = config.defaultModel ?? this.models[0];
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  /**
   * 同步调用 LLM
   *
   * 将框架的 LLMRequest 转换为 OpenAI API 格式，发送请求，
   * 然后将响应转换回框架的 LLMResponse 格式。
   */
  async complete(request: LLMRequest): Promise<LLMResponse> {
    const body = this.buildRequestBody(request);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

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
   * 返回一个 AsyncIterable，逐步产出 LLMResponse。
   * 每个 chunk 的 content 是增量内容。
   * 工具调用通过 buffer 拼接，在流结束时一次性输出。
   */
  async *stream(request: LLMRequest): AsyncIterable<LLMResponse> {
    const body = { ...this.buildRequestBody(request), stream: true };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    // tool_calls 拼接 buffer（index → {id, name, argsBuffer}）
    const toolCallBuffers = new Map<number, { id: string; name: string; argsBuffer: string }>();
    let textContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          // 流结束：输出最终结果
          if (toolCallBuffers.size > 0) {
            const toolCalls: ToolCall[] = [];
            for (const [, buf] of toolCallBuffers) {
              toolCalls.push({
                id: buf.id,
                name: buf.name,
                arguments: (() => { try { return JSON.parse(buf.argsBuffer); } catch { return {}; } })(),
              });
            }
            yield {
              content: textContent || '',
              toolCalls,
              model: request.model,
              finishReason: 'tool_calls',
            };
          } else if (textContent) {
            // 纯文本回复：输出最终结果
            yield {
              content: textContent,
              model: request.model,
              finishReason: 'stop',
            };
          }
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          // 文本内容：增量输出
          if (delta.content) {
            textContent += delta.content;
            yield {
              content: delta.content,
              model: parsed.model ?? request.model,
              finishReason: parsed.choices?.[0]?.finish_reason ?? 'stop',
            };
          }

          // reasoning 输出（Ollama 特有）
          if (delta.reasoning) {
            textContent += delta.reasoning;
            yield {
              content: delta.reasoning,
              model: parsed.model ?? request.model,
              finishReason: parsed.choices?.[0]?.finish_reason ?? 'stop',
            };
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
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<boolean> {
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
   *
   * 消息格式净化：剥离框架内部字段，只保留 OpenAI API 所需字段。
   */
  private buildRequestBody(request: LLMRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model || this.defaultModel,
      messages: request.messages.map((msg: any) => this.sanitizeMessage(msg)),
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
    }

    return body;
  }

  /**
   * 净化消息：只保留 OpenAI API 所需字段
   */
  private sanitizeMessage(msg: any): any {
    const clean: any = {
      role: msg.role,
      content: msg.content ?? null,
    };

    // assistant 消息：保留 tool_calls
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      clean.tool_calls = msg.tool_calls;
    }

    // tool 消息：必须有 tool_call_id 和 name
    if (msg.role === 'tool') {
      if (msg.tool_call_id) clean.tool_call_id = msg.tool_call_id;
      else if (msg.toolResults?.[0]?.toolCallId) clean.tool_call_id = msg.toolResults[0].toolCallId;
      if (msg.name) clean.name = msg.name;
      else if (msg.toolResults?.[0]?.name) clean.name = msg.toolResults[0].name;
    }

    return clean;
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
      } : undefined,
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
