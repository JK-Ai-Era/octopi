/**
 * Message Converter — 内部/外部消息转换器
 *
 * 内部用 Message（丰富元数据），LLM 边界用 LLMMessage（provider 格式）。
 * 转换逻辑集中在一处，不散落在各处。
 */

import type {
  Message,
  LLMMessage,
  MessageConverter,
  ToolCall,
} from '../core/types.js';

/**
 * 创建默认的 MessageConverter
 *
 * 支持 OpenAI / Anthropic / 通用兼容格式。
 * 内部元数据（source/taskId/turnId）在转换时自动剥离。
 */
export function createMessageConverter(): MessageConverter {
  return {
    toLlm(messages: Message[], stripMeta = true): LLMMessage[] {
      return messages.map((msg) => convertOneToLlm(msg, stripMeta));
    },

    fromLlm(message: LLMMessage): Message {
      return convertOneFromLlm(message);
    },
  };
}

/**
 * 内部 Message → LLM Message
 */
function convertOneToLlm(msg: Message, stripMeta: boolean): LLMMessage {
  const llm: LLMMessage = {
    role: msg.role,
    content: msg.content || null,
  };

  // assistant 消息的 tool_calls
  if (msg.role === 'assistant' && msg.toolCalls?.length) {
    llm.tool_calls = msg.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: typeof tc.arguments === 'string'
          ? tc.arguments
          : JSON.stringify(tc.arguments),
      },
    }));
  }

  // tool 消息的 tool_call_id 和 name
  if (msg.role === 'tool' && msg.toolResults?.length) {
    // 一条 tool 消息可能包含多个 tool result
    // 但 LLM API 要求每个 tool result 是独立的消息
    // 这里只取第一个（调用方应确保一对一）
    const result = msg.toolResults[0];
    if (result) {
      llm.tool_call_id = result.toolCallId;
      llm.name = result.name;
      llm.content = result.error
        ? `Error: ${result.error}`
        : typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
    }
  }

  // 非 stripMeta 模式：保留元数据（用于调试）
  if (!stripMeta && msg.metadata) {
    (llm as any)._metadata = msg.metadata;
  }

  return llm;
}

/**
 * LLM Message → 内部 Message
 */
function convertOneFromLlm(message: LLMMessage): Message {
  const msg: Message = {
    role: message.role as Message['role'],
    content: message.content ?? '',
    timestamp: Date.now(),
  };

  // 转换 tool_calls
  if (message.tool_calls?.length) {
    msg.toolCalls = message.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: parseJsonSafe(tc.function.arguments),
    }));
  }

  // tool 消息：构建 toolResults
  if (message.role === 'tool' && message.tool_call_id) {
    msg.toolResults = [
      {
        toolCallId: message.tool_call_id,
        name: message.name ?? 'unknown',
        result: msg.content,
      },
    ];
  }

  return msg;
}

/**
 * 安全解析 JSON，失败返回原始字符串
 */
function parseJsonSafe(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed;
    }
    return { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}
