/**
 * Anthropic Messages API Provider
 *
 * 实现 Anthropic Messages 协议 (`POST /v1/messages`)。
 * 与 OpenAI provider 的关键区别：
 *
 * | 维度 | OpenAI | Anthropic |
 * |------|--------|-----------|
 * | 端点 | `/v1/chat/completions` | `/v1/messages` |
 * | 认证 | `Authorization: Bearer <key>` | `x-api-key: <key>` |
 * | 系统提示 | `messages[0].role === "system"` | 顶层 `system` 字段（不在 messages 中） |
 * | 工具格式 | `function: { name, parameters }` | `{ name, input_schema }` |
 * | 响应格式 | `choices[0].message` | `content[]` 数组 |
 * | 工具调用 | `tool_calls[]` | `content[].type === "tool_use"` |
 * | 流式协议 | SSE `data: {...}` | SSE `event: content_block_*` |
 * | 最大输出 | `max_tokens` 可选 | `max_tokens` 必填 |
 *
 * 兼容性说明：
 * - Octopi 的内部消息格式以 OpenAI 风格为基准
 * - 本 provider 在发送请求前将 OpenAI 格式转换为 Anthropic 格式
 * - 收到响应后将 Anthropic 格式转换回 OpenAI 格式
 * - 这样 AgentLoop 不需要关心底层协议差异
 */

import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ToolCall,
} from '../core/types.js';

export interface AnthropicProviderConfig {
  name?: string;
  apiKey: string;
  baseUrl?: string;      // 默认 https://api.anthropic.com
  version?: string;      // API 版本，默认 2023-06-01
  models?: string[];     // 可用模型列表
  defaultModel?: string; // 默认模型
}

/**
 * Anthropic Messages Provider
 *
 * 将 Anthropic Messages API 适配到 AgentHarness 的 LLMProvider 接口。
 * 内部做 OpenAI ↔ Anthropic 格式双向转换，让 AgentLoop 无需感知协议差异。
 */
export class AnthropicProvider implements LLMProvider {
  readonly name: string;
  readonly models: string[];

  private apiKey: string;
  private baseUrl: string;
  private version: string;
  private defaultModel: string;

  constructor(config: AnthropicProviderConfig) {
    this.name = config.name ?? 'anthropic';
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.version = config.version ?? '2023-06-01';
    this.models = config.models ?? [
      'claude-sonnet-4-20250514',
      'claude-haiku-4-20250414',
      'claude-3-5-sonnet-20241022',
    ];
    this.defaultModel = config.defaultModel ?? this.models[0];
  }

  /**
   * 同步调用 Anthropic Messages API
   *
   * 核心转换逻辑：
   * 1. 从 OpenAI messages 中提取 system prompt → Anthropic 顶层 `system` 字段
   * 2. 将 OpenAI 工具格式转换为 Anthropic 的 `input_schema` 格式
   * 3. 将 Anthropic 响应 `content[]` 数组转换回 OpenAI 的 `choices[].message` 格式
   */
  async complete(request: LLMRequest): Promise<LLMResponse> {
    const anthropicRequest = this.toAnthropicRequest(request);

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.version,
      },
      body: JSON.stringify(anthropicRequest),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${error}`);
    }

    const data = await response.json() as Record<string, unknown>;
    return this.fromAnthropicResponse(data, request.model);
  }

  /**
   * 流式调用 Anthropic Messages API
   *
   * Anthropic 的流式协议与 OpenAI 不同：
   * - 使用 SSE 事件类型（`content_block_start`, `content_block_delta` 等）
   * - 工具调用通过 `tool_use` content block 传递
   * - `message_stop` 事件表示流结束
   *
   * 我们将这些事件转换回 OpenAI 的 `LLMResponse` 格式。
   */
  async *stream(request: LLMRequest): AsyncIterable<LLMResponse> {
    const anthropicRequest = {
      ...this.toAnthropicRequest(request),
      stream: true,
    };

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.version,
      },
      body: JSON.stringify(anthropicRequest),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let textContent = '';
    let currentToolId = '';
    let currentToolName = '';
    let toolArgsBuffer = '';
    const toolCalls: ToolCall[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ') || !line.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(line.slice(6)) as Record<string, unknown>;

            if (data.type === 'content_block_start') {
              const block = data.content_block as Record<string, unknown> | undefined;
              if (block?.type === 'tool_use') {
                currentToolId = block.id as string;
                currentToolName = block.name as string;
                toolArgsBuffer = '';
              }
            } else if (data.type === 'content_block_delta') {
              const delta = data.delta as Record<string, unknown> | undefined;
              if (delta?.type === 'text_delta') {
                textContent += (delta.text as string) ?? '';
                yield {
                  content: (delta.text as string) ?? '',
                  model: request.model,
                  finishReason: 'stop',
                };
              } else if (delta?.type === 'input_json_delta') {
                toolArgsBuffer += (delta.partial_json as string) ?? '';
              }
            } else if (data.type === 'content_block_stop') {
              if (currentToolId) {
                let args: Record<string, unknown> = {};
                try { args = JSON.parse(toolArgsBuffer); } catch { /* ignore */ }
                toolCalls.push({
                  id: currentToolId,
                  name: currentToolName,
                  arguments: args,
                });
                currentToolId = '';
                currentToolName = '';
                toolArgsBuffer = '';
              }
            } else if (data.type === 'message_delta') {
              const delta = data.delta as Record<string, unknown> | undefined;
              const stopReason = delta?.stop_reason as string;
              const result: LLMResponse = {
                content: textContent || '',
                model: request.model,
                finishReason: stopReason === 'tool_calls' ? 'tool_calls' : 'stop',
              };
              if (toolCalls.length > 0) {
                result.toolCalls = [...toolCalls];
              }
              yield result;
            }
          } catch {
            // 忽略非 JSON 行
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.version,
        },
        body: JSON.stringify({
          model: this.defaultModel,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      // 400 也算健康（说明 API 可达，只是参数问题）
      return response.ok || response.status === 400;
    } catch {
      return false;
    }
  }

  // ===== 格式转换 =====

  /**
   * OpenAI 格式 → Anthropic 格式
   *
   * 关键转换：
   * 1. 提取 system message → 顶层 `system` 字段
   * 2. 过滤掉 system message（Anthropic 不允许 system 角色在 messages 中）
   * 3. 转换工具定义格式（parameters → input_schema）
   * 4. max_tokens 必填（Anthropic 要求）
   */
  private toAnthropicRequest(request: LLMRequest): Record<string, unknown> {
    // 提取 system prompt
    const systemMessages = request.messages.filter((m) => m.role === 'system');
    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');
    const systemPrompt = systemMessages.map((m) => m.content).join('\n\n');

    // 转换消息格式
    const messages = nonSystemMessages.map((m) => this.toAnthropicMessage(m));

    // 转换工具格式
    const tools = request.tools?.map((t) => this.toAnthropicTool(t as Record<string, unknown>));

    const anthropicRequest: Record<string, unknown> = {
      model: request.model || this.defaultModel,
      max_tokens: request.maxTokens ?? 4096,
      messages,
    };

    if (systemPrompt) {
      anthropicRequest.system = systemPrompt;
    }
    if (request.temperature !== undefined) {
      anthropicRequest.temperature = request.temperature;
    }
    if (tools && tools.length > 0) {
      anthropicRequest.tools = tools;
    }

    return anthropicRequest;
  }

  /**
   * 将 OpenAI 消息格式转换为 Anthropic 消息格式
   *
   * 主要差异：
   * - Anthropic 不支持 `role: "system"`（已在外层处理）
   * - `assistant` 消息的 tool_calls 需要转换为 `content` 数组
   * - `tool` 角色的消息需要转换为 `user` 角色 + `tool_result` 内容块
   */
  private toAnthropicMessage(msg: { role: string; content: string; tool_calls?: unknown[] }): Record<string, unknown> {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // Assistant 消息带工具调用 → content 数组
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function ? (tc.function as Record<string, unknown>).name : tc.name,
          input: tc.function
            ? this.safeParseJson((tc.function as Record<string, unknown>).arguments as string)
            : (tc.arguments ?? {}),
        });
      }
      return { role: 'assistant', content };
    }

    // 普通 user/assistant 消息
    return {
      role: msg.role,
      content: msg.content,
    };
  }

  /**
   * 将 OpenAI 工具定义转换为 Anthropic 格式
   *
   * OpenAI:  { type: "function", function: { name, description, parameters } }
   * Anthropic: { name, description, input_schema }
   */
  private toAnthropicTool(tool: Record<string, unknown>): Record<string, unknown> {
    const fn = tool.function as Record<string, unknown> | undefined;
    return {
      name: fn?.name ?? tool.name,
      description: fn?.description ?? tool.description,
      input_schema: fn?.parameters ?? tool.parameters ?? { type: 'object', properties: {} },
    };
  }

  /**
   * Anthropic 响应 → OpenAI 格式
   *
   * Anthropic 的 `content` 是一个数组，可能包含：
   * - { type: "text", text: "..." } — 文本内容
   * - { type: "tool_use", id, name, input } — 工具调用
   *
   * 需要将它们合并回 OpenAI 的 `LLMResponse` 格式。
   */
  private fromAnthropicResponse(data: Record<string, unknown>, model: string): LLMResponse {
    const contentBlocks = (data.content as Array<Record<string, unknown>>) ?? [];
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        textParts.push(block.text as string);
      } else if (block.type === 'tool_use') {
        const input = (block.input ?? {}) as Record<string, unknown>;
        toolCalls.push({
          id: block.id as string,
          name: block.name as string,
          arguments: input,
        });
      }
    }

    // 映射 Anthropic stop_reason → finishReason
    const stopReason = data.stop_reason as string;
    let finishReason: LLMResponse['finishReason'] = 'stop';
    if (stopReason === 'tool_use') finishReason = 'tool_calls';
    else if (stopReason === 'max_tokens') finishReason = 'length';

    const usage = data.usage as Record<string, number> | undefined;

    const result: LLMResponse = {
      content: textParts.join('') || '',
      model: (data.model as string) ?? model,
      finishReason,
    };

    if (toolCalls.length > 0) {
      result.toolCalls = toolCalls;
    }

    if (usage) {
      result.usage = {
        promptTokens: usage.input_tokens ?? 0,
        completionTokens: usage.output_tokens ?? 0,
        totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      };
    }

    return result;
  }

  private safeParseJson(str: string | undefined): Record<string, unknown> {
    if (!str) return {};
    try {
      return JSON.parse(str) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
