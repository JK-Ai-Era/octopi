import type { LLMProvider, LLMRequest, LLMResponse } from '../core/types.js';

/**
 * LLM 路由器
 *
 * 支持多 provider 注册 + 模型路由 + fallback
 */
export class LLMRouter {
  private providers = new Map<string, LLMProvider>();

  register(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
  }

  unregister(name: string): void {
    this.providers.delete(name);
  }

  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  listModels(): string[] {
    const models: string[] = [];
    for (const provider of this.providers.values()) {
      models.push(...provider.models);
    }
    return models;
  }

  async healthCheckAll(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    for (const [name, provider] of this.providers) {
      try {
        results[name] = provider.healthCheck ? await provider.healthCheck() : true;
      } catch {
        results[name] = false;
      }
    }
    return results;
  }
}
