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
 * 实现 ModelProvider 接口。
 */

import type {
  ModelProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from '../../core/interfaces/model-provider.js';
import type { ToolCall, ModelInfo } from '../../core/types.js';

export interface AnthropicProviderConfig {
  name?: string;
  apiKey: string;
  baseUrl?: string;
  version?: string;
  /**
   * 支持的模型列表
   *
   * 两种形式：
   * - string: 只有模型名称
   * - ModelInfo: 名称 + 能力声明（contextWindow, maxOutputTokens）
   */
  models?: (string | ModelInfo)[];
  defaultModel?: string;
}

/**
 * Anthropic Messages Provider
 *
 * 实现 ModelProvider 接口。
 */
export class AnthropicProvider implements ModelProvider {
  readonly name: string;
  readonly models: string[];
  private modelInfoMap: Map<string, ModelInfo> = new Map();

  private apiKey: string;
  private baseUrl: string;
  private version: string;
  private defaultModel: string;

  constructor(config: AnthropicProviderConfig) {
    this.name = config.name ?? 'anthropic';
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.version = config.version ?? '2023-06-01';

    // 解析 models 配置：提取名称列表 + ModelInfo 映射
    const rawModels = config.models ?? [
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-haiku-4-5',
    ];
    this.models = [];
    for (const entry of rawModels) {
      if (typeof entry === 'string') {
        this.models.push(entry);
      } else {
        this.models.push(entry.name);
        this.modelInfoMap.set(entry.name, entry);
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

  /**
   * 同步调用 Anthropic Messages API
   */
  async chat(request: LLMRequest): Promise<LLMResponse> {
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
    return this.fromAnthropicResponse(data, request.model ?? this.defaultModel);
  }

  /**
   * 流式调用 Anthropic Messages API
   *
   * 返回 AsyncGenerator<LLMStreamChunk>，逐步产出内容。
   */
  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
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
    let currentToolId = '';
    let currentToolName = '';
    let toolArgsBuffer = '';
    let toolCallIndex = 0;

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
                yield { type: 'content', content: (delta.text as string) ?? '' };
              } else if (delta?.type === 'input_json_delta') {
                toolArgsBuffer += (delta.partial_json as string) ?? '';
              }
            } else if (data.type === 'content_block_stop') {
              if (currentToolId) {
                let args: Record<string, unknown> = {};
                try { args = JSON.parse(toolArgsBuffer); } catch { /* ignore */ }
                yield {
                  type: 'tool_call',
                  toolCall: {
                    id: currentToolId,
                    name: currentToolName,
                    arguments: toolArgsBuffer,
                    index: toolCallIndex,
                  },
                };
                toolCallIndex++;
                currentToolId = '';
                currentToolName = '';
                toolArgsBuffer = '';
              }
            } else if (data.type === 'message_stop') {
              yield { type: 'done' };
              return;
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

  /**
   * 检查 provider 是否可用
   */
  async isAvailable(): Promise<boolean> {
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
      return response.ok || response.status === 400;
    } catch {
      return false;
    }
  }

  // ===== 格式转换 =====

  /**
   * OpenAI 格式 → Anthropic 格式
   */
  private toAnthropicRequest(request: LLMRequest): Record<string, unknown> {
    const systemMessages = request.messages.filter((m) => m.role === 'system');
    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');
    const systemPrompt = systemMessages.map((m) => String(m.content ?? '')).join('\n\n');

    const messages = nonSystemMessages.map((m) => this.toAnthropicMessage(m as any));
    const tools = request.tools?.map((t) => this.toAnthropicTool(t as any));

    const anthropicRequest: Record<string, unknown> = {
      model: (request.model as string) || this.defaultModel,
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
   */
  private toAnthropicMessage(msg: Record<string, unknown>): Record<string, unknown> {
    const role = String(msg.role);
    const textContent = String(msg.content ?? '');

    if (role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      if (textContent) {
        blocks.push({ type: 'text', text: textContent });
      }
      for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function ? (tc.function as Record<string, unknown>).name : tc.name,
          input: tc.function
            ? this.safeParseJson(String((tc.function as Record<string, unknown>).arguments ?? '{}'))
            : (tc.arguments ?? {}),
        });
      }
      return { role: 'assistant', content: blocks };
    }

    return { role, content: textContent };
  }

  /**
   * 将 OpenAI 工具定义转换为 Anthropic 格式
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
