/**
 * FallbackProvider — 模型回退提供器
 *
 * 包装多个 ModelProvider，按顺序尝试。
 * 主 provider 失败时自动切换到下一个回退 provider。
 *
 * 使用场景：
 * - 主模型不可用（circuit breaker open、限流、超时）
 * - 主模型返回错误
 * - 跨 provider 灾备（如 OpenAI -> Anthropic）
 */

import type {
  ModelProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from '../../core/interfaces/model-provider.js';
import type { ModelConfig, ModelInfo } from '../../core/types/agent-definition.js';

/** FallbackProvider 配置项 */
interface FallbackEntry {
  provider: ModelProvider;
  model: string;
  defaultModel?: string;
}

/**
 * 回退感知的 ModelProvider
 *
 * 尝试主 provider，失败后按 fallbackModels 顺序尝试备选。
 * 每次调用独立决策，不持久化状态。
 */
export class FallbackProvider implements ModelProvider {
  readonly name: string;
  readonly defaultModel?: string;

  private chain: FallbackEntry[];

  constructor(
    mainProvider: ModelProvider,
    mainModel: string,
    fallbackModels: ModelConfig[],
    providerMap: Map<string, ModelProvider>,
  ) {
    this.name = mainProvider.name;

    this.chain = [{ provider: mainProvider, model: mainModel, defaultModel: mainProvider.defaultModel }];

    for (const fb of fallbackModels) {
      const fbProvider = providerMap.get(fb.provider);
      if (!fbProvider) {
        console.warn(`[FallbackProvider] Fallback provider "${fb.provider}" not found, skipping`);
        continue;
      }
      this.chain.push({ provider: fbProvider, model: fb.model });
    }

    this.defaultModel = mainModel;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    let lastError: unknown;

    for (const entry of this.chain) {
      try {
        return await entry.provider.chat({
          ...request,
          model: entry.model,
        });
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[FallbackProvider] ${entry.provider.name}/${entry.model} failed: ${msg}`);
      }
    }

    throw lastError ?? new Error('All fallback providers exhausted');
  }

  /**
   * 流式生成回复
   *
   * 尝试主 provider 的 stream()，失败则按 fallbackModels 顺序尝试备选。
   *
   * 注意：一旦某个 provider 成功产出第一个 chunk，后续就完全委托给该 provider。
   * 如果该 provider 在流中途抛异常，错误会直接传递给调用方，不会触发回退。
   * 这是流式生成的固有限制——已产出的内容无法撤回。
   */
  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
    let lastError: unknown;

    for (const entry of this.chain) {
      // try/catch 仅覆盖初始化阶段（创建 stream + 获取首个 chunk）。
      // 一旦首个 chunk 成功产出，后续 yield* 在 try/catch 之外执行，
      // 确保流中途错误直接向上传播，不会被吞掉后静默回退。
      let gen: AsyncGenerator<LLMStreamChunk>;
      let first: IteratorResult<LLMStreamChunk>;
      try {
        gen = entry.provider.stream({ ...request, model: entry.model });
        first = await gen.next();
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[FallbackProvider] ${entry.provider.name}/${entry.model} stream failed: ${msg}`);
        continue;
      }

      if (first.done) continue;

      // 首个 chunk 成功，完全委托给当前 provider（无 try/catch 包裹）
      yield first.value;
      yield* gen;
      return;
    }

    throw lastError ?? new Error('All fallback providers exhausted');
  }

  async isAvailable(): Promise<boolean> {
    // 任一 provider 可用即可
    for (const entry of this.chain) {
      try {
        if (await entry.provider.isAvailable()) return true;
      } catch {
        // ignore
      }
    }
    return false;
  }

  getModelInfo(modelName: string) {
    // 从 chain 中查找匹配的 provider
    for (const entry of this.chain) {
      const info = entry.provider.getModelInfo(modelName);
      if (info) return info;
    }
    return this.chain[0]?.provider.getModelInfo(this.chain[0].model) ?? null;
  }

  getModelInfos(): ModelInfo[] {
    // 合并所有 provider 的 model info
    const infos: ReturnType<ModelProvider['getModelInfos']> = [];
    for (const entry of this.chain) {
      infos.push(...entry.provider.getModelInfos());
    }
    return infos;
  }
}
