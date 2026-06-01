import type { LLMProvider, LLMRequest, LLMResponse, Session } from '../core/types.js';

/**
 * LLM 路由器
 *
 * 职责：
 * - 管理多个 LLM Provider
 * - 根据 session 配置路由请求
 * - 支持 fallback
 */
export class LLMRouter {
  private providers = new Map<string, LLMProvider>();
  private modelToProvider = new Map<string, string>();

  register(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
    for (const model of provider.models) {
      this.modelToProvider.set(model, provider.name);
    }
  }

  unregister(name: string): void {
    const provider = this.providers.get(name);
    if (provider) {
      for (const model of provider.models) {
        this.modelToProvider.delete(model);
      }
      this.providers.delete(name);
    }
  }

  /**
   * 根据 session 配置解析出对应的 provider
   */
  resolve(session: Session): LLMProvider {
    // 从 session 的最后一条 turn 的 model 推断
    const lastTurn = session.turns[session.turns.length - 1];
    const model = lastTurn?.model;

    if (model) {
      const providerName = this.modelToProvider.get(model);
      if (providerName) {
        const provider = this.providers.get(providerName);
        if (provider) return provider;
      }
    }

    // 默认返回第一个注册的 provider
    const first = this.providers.values().next();
    if (!first.done) return first.value;

    throw new Error('No LLM provider registered');
  }

  /**
   * 直接按 provider 名称获取
   */
  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * 列出所有可用的模型
   */
  listModels(): string[] {
    return Array.from(this.modelToProvider.keys());
  }

  /**
   * 健康检查所有 provider
   */
  async healthCheckAll(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    for (const [name, provider] of this.providers) {
      try {
        results[name] = provider.healthCheck
          ? await provider.healthCheck()
          : true;
      } catch {
        results[name] = false;
      }
    }
    return results;
  }
}
