/**
 * 内容过滤拒答守卫 — ModelProvider 装饰器
 *
 * 把「正文=罐头拒答」的 200 内联返回转成 ContentFilterError（content_filter 模型错误），
 * 复用既有 onError/重试链路：阈值型误杀原样重试常过；重试耗尽走既有诚实收口
 * （stopReason=llm_error + 「模型调用失败…可继续对话重试」），拒答语永远不会落成
 * 助手回答。
 *
 * 流式路径按前缀扣发罐头正文：正常回答仅在「累计正文仍是拒答签名前缀」的短暂窗口内
 * 缓冲，一旦脱离签名前缀立即冲刷透传；reasoning / tool_call 块不经缓冲（有工具调用的
 * 响应不是拒答，遇 tool_call 即转全透传）。
 */

import type {
  ModelProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from '@octopi-agent/core/interfaces/model-provider.js';
import type { ModelInfo } from '@octopi-agent/core/types.js';
import {
  ContentFilterError,
  isCannedRefusalText,
  isCannedRefusalPrefix,
} from '@octopi-agent/core/loop/canned-refusal.js';

/**
 * 响应级拒答判定：正文恰为罐头拒答且无工具调用时抛 ContentFilterError。
 *
 * @param response - 同步调用响应
 * @throws {ContentFilterError} 正文为罐头拒答时
 */
function assertNotCannedRefusal(response: LLMResponse): void {
  if (response.toolCalls?.length) return; // 有工具调用的响应不是拒答
  if (response.content && isCannedRefusalText(response.content)) {
    throw new ContentFilterError(response.content);
  }
}

/**
 * 流式守卫：内容块按前缀扣发，落定为罐头拒答时抛 ContentFilterError。
 *
 * @param model - 被包装的 provider
 * @param request - LLM 请求
 * @returns 受守卫的流（正常内容照常流出，仅拒答前缀窗口内缓冲）
 * @throws {ContentFilterError} 流的最终正文为罐头拒答时
 */
async function* guardedStream(
  model: ModelProvider,
  request: LLMRequest,
): AsyncGenerator<LLMStreamChunk> {
  let contentBuf = '';
  let sawToolCall = false;
  for await (const chunk of model.stream(request)) {
    if (chunk.type === 'tool_call') {
      sawToolCall = true;
      if (contentBuf) {
        yield { type: 'content', content: contentBuf };
        contentBuf = '';
      }
      yield chunk;
      continue;
    }
    if (chunk.type === 'content' && !sawToolCall) {
      contentBuf += chunk.content ?? '';
      if (isCannedRefusalPrefix(contentBuf)) continue; // 疑似罐头：继续扣发
      yield { type: 'content', content: contentBuf };
      contentBuf = '';
      continue;
    }
    if (chunk.type === 'done') {
      if (!sawToolCall && contentBuf && isCannedRefusalText(contentBuf)) {
        throw new ContentFilterError(contentBuf);
      }
      if (contentBuf) {
        yield { type: 'content', content: contentBuf };
        contentBuf = '';
      }
      yield chunk;
      continue;
    }
    yield chunk;
  }
  // 流异常结束（无 done）：非罐头的残留正文不丢输出
  if (contentBuf && !isCannedRefusalText(contentBuf)) {
    yield { type: 'content', content: contentBuf };
  }
}

/**
 * 为 ModelProvider 套上内容过滤拒答守卫。
 *
 * @param model - 被包装的 provider（可与 FallbackProvider 等装饰器叠放）
 * @returns 守卫后的 provider（接口同构，方法逐个显式委托——展开抄不到原型方法）
 */
export function guardRefusalProvider(model: ModelProvider): ModelProvider {
  return {
    name: model.name,
    defaultModel: model.defaultModel,
    ...(model.models ? { models: model.models } : {}),
    getModelInfo: (modelName: string): ModelInfo | null => model.getModelInfo(modelName),
    getModelInfos: (): ModelInfo[] => model.getModelInfos(),
    isAvailable: (): Promise<boolean> => model.isAvailable(),
    ...(model.dispose
      ? {
          dispose: (): void | Promise<void> => {
            model.dispose?.();
          },
        }
      : {}),
    chat: async (request: LLMRequest): Promise<LLMResponse> => {
      const response = await model.chat(request);
      assertNotCannedRefusal(response);
      return response;
    },
    stream: (request: LLMRequest): AsyncGenerator<LLMStreamChunk> => guardedStream(model, request),
  };
}
