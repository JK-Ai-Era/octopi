/**
 * ProviderSummarize — 用 ModelProvider 实现 SummarizeFunction
 *
 * 供 ContextEngine 的 LLM 摘要压缩路径使用。
 * 默认产品路径在未显式 `.summarize()` 时自动挂接（见 AgentBuilder）。
 */

import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type { LLMMessage } from '../../core/interfaces/model-provider.js';
import type { SummarizeFunction } from './types.js';

export interface CreateProviderSummarizeOptions {
  /** 指定模型名（provider.defaultModel 之外） */
  model?: string;
  /** 摘要温度（默认 0.3，偏确定性） */
  temperature?: number;
}

/**
 * 创建基于 ModelProvider 的摘要函数
 *
 * @param provider - 用于调用的模型提供者（宜用 mini/便宜档）
 * @param options - 模型名与温度
 * @returns SummarizeFunction；调用失败向上抛出，由 HybridCompressor 回退截断
 */
export function createProviderSummarize(
  provider: ModelProvider,
  options?: CreateProviderSummarizeOptions,
): SummarizeFunction {
  return async (messages: LLMMessage[], opts) => {
    const response = await provider.chat({
      messages,
      model: options?.model,
      temperature: options?.temperature ?? 0.3,
      maxTokens: opts?.maxTokens,
    });
    return response.content;
  };
}

/**
 * 从 model level 映射中挑摘要用 provider
 *
 * 优先级：summary → mini → standard → 传入的 fallbackProvider（通常是主模型）
 *
 * @param providers - 可用 provider 映射
 * @param levelMap - models.level 配置（primary 为 provider/model）
 * @param fallbackProvider - 兜底 provider
 * @returns 选中的 provider + 建议模型名
 */
export function pickSummarizeProvider(
  providers: Map<string, ModelProvider>,
  levelMap: Record<string, { primary: string; fallback?: string[] }> | undefined,
  fallbackProvider: ModelProvider,
): { provider: ModelProvider; model?: string } {
  for (const levelName of ['summary', 'mini', 'standard'] as const) {
    const primary = levelMap?.[levelName]?.primary;
    if (!primary) continue;
    const slash = primary.indexOf('/');
    if (slash <= 0) continue;
    const providerName = primary.slice(0, slash);
    const model = primary.slice(slash + 1);
    const provider = providers.get(providerName);
    if (provider) return { provider, model };
  }
  return { provider: fallbackProvider };
}
