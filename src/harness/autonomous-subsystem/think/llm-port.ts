/**
 * Autonomous Subsystem — SubsystemLLMPort
 *
 * 子系统统一 LLM 能力端口：code handler 与 framework Think（llm/hybrid）共用同一套
 * 模型解析、默认认知 prompt（SUBSYSTEM.md）与 fallback 策略。
 *
 * 设计：
 * - `chat()`：单次调用（handler 内语义增强等场景）
 * - `resolved`：完整 primary + fallback 链，供 ThinkExecutor 构建 Agent 时复用
 * - 不强制 Agent loop；需要工具/多轮时由 ThinkExecutor 或 handler 显式选择
 *
 * @module autonomous-subsystem/think/llm-port
 */

import type {
  ModelProvider,
  LLMMessage,
  LLMRequest,
  LLMResponse,
} from '../../../core/interfaces/model-provider.js';
import type { ModelResolver, ResolvedModelWithFallback, ResolvedModel } from './model-resolver.js';

/** 注入依赖键：统一 LLM 端口 */
export const DEP_LLM_PORT = 'llmPort';
/** 注入依赖键：SUBSYSTEM.md 正文（认知指令） */
export const DEP_SUBSYSTEM_PROMPT = '__subsystem_prompt__';
/** 注入依赖键：解析后的主模型名（兼容旧 handler） */
export const DEP_RESOLVED_MODEL = '__resolved_model__';
/** 注入依赖键：完整 primary + fallback 链 */
export const DEP_RESOLVED_MODELS = '__resolved_models__';

export interface SubsystemLLMPortChatRequest {
  /** 对话消息（不含 system；system 由 port 或显式 systemPrompt 提供） */
  messages: LLMMessage[];
  /** 覆盖认知 prompt；默认使用 port 绑定的 SUBSYSTEM.md 正文 */
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** 覆盖默认模型名 */
  model?: string;
  signal?: AbortSignal;
}

export interface SubsystemLLMPort {
  /** SUBSYSTEM.md 正文（认知指令），可能为空 */
  readonly cognitivePrompt: string;
  /** 默认模型名（primary） */
  readonly defaultModel: string;
  /** 默认 provider 名 */
  readonly providerName: string;
  /** 完整解析结果（含 fallback） */
  readonly resolved: ResolvedModelWithFallback;
  /** 单次调用；按 resolved 链自动 fallback */
  chat(request: SubsystemLLMPortChatRequest): Promise<LLMResponse>;
}

export interface CreateSubsystemLLMPortOptions {
  provider: ModelProvider;
  modelResolver: ModelResolver;
  /** think.model 引用；缺省 'standard' */
  modelRef?: string;
  /** SUBSYSTEM.md 正文 */
  cognitivePrompt?: string;
}

/**
 * 判断是否应触发模型 fallback
 *
 * @param err - 调用失败错误
 * @returns 是否尝试下一模型
 */
export function shouldFallbackModel(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // 限流 / 配额
  if (/\b429\b/.test(msg) || msg.includes('rate limit') || msg.includes('rate_limit') || msg.includes('quota')) {
    return true;
  }
  // 超时
  if (msg.includes('timed out') || msg.includes('timeout')) return true;
  // 5xx
  if (/\b50[0-3]\b/.test(msg)) return true;
  // 网络瞬断
  if (
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up')
  ) {
    return true;
  }
  // 服务过载
  if (msg.includes('overloaded') || msg.includes('capacity')) return true;
  return false;
}

function toResolvedModel(model: ResolvedModel): string {
  // ModelProvider.chat 的 model 字段使用模型名；provider 由注入的 provider 实例决定
  return model.model;
}

/**
 * 创建子系统 LLM 端口
 */
export function createSubsystemLLMPort(
  options: CreateSubsystemLLMPortOptions,
): SubsystemLLMPort {
  const { provider, modelResolver, modelRef, cognitivePrompt } = options;
  const resolved = modelResolver.resolve(modelRef ?? 'standard');

  const chat = async (request: SubsystemLLMPortChatRequest): Promise<LLMResponse> => {
    const system = request.systemPrompt ?? cognitivePrompt;
    const messages: LLMMessage[] = system
      ? [{ role: 'system', content: system }, ...request.messages]
      : [...request.messages];

    // 调用方覆盖 model 时，仍经 ModelResolver 解析出 primary+fallback，禁止钉死单模型
    const chain = request.model
      ? modelResolver.resolve(request.model)
      : resolved;
    const modelsToTry = [chain.primary, ...chain.fallback];

    let lastErr: unknown;
    for (let i = 0; i < modelsToTry.length; i++) {
      const modelName = toResolvedModel(modelsToTry[i]!);
      const llmRequest: LLMRequest = {
        messages,
        model: modelName,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        signal: request.signal,
      };

      try {
        const response = await provider.chat(llmRequest);
        if (response.finishReason === 'error') {
          lastErr = new Error(response.content || 'LLM chat error');
          // 与 catch 路径同一策略：仅瞬时/可重试错误才换模型，避免鉴权/参数错白试
          if (i < modelsToTry.length - 1 && shouldFallbackModel(lastErr)) {
            continue;
          }
          return response;
        }
        return response;
      } catch (err) {
        lastErr = err;
        if (request.signal?.aborted) {
          throw err;
        }
        if (i < modelsToTry.length - 1 && shouldFallbackModel(err)) {
          continue;
        }
        throw err;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error('LLM chat failed');
  };

  return {
    cognitivePrompt: cognitivePrompt ?? '',
    defaultModel: resolved.primary.model,
    providerName: provider.name,
    resolved,
    chat,
  };
}
