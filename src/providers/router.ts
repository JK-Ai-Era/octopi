/**
 * LLM 路由器
 *
 * 管理所有已注册的 LLM Provider，提供：
 * - Provider 注册/注销
 * - 模型列表查询
 * - 健康检查
 *
 * 路由逻辑：
 *   请求 → LLMRouter → 根据 provider name 找到 Provider → 调用 complete()
 *
 * TODO: 增加 fallback 逻辑（主模型失败时自动尝试 fallback models）
 */

import type { LLMProvider, LLMRequest, LLMResponse } from '../core/types.js';

export class LLMRouter {
  /** 已注册的 provider（name → provider） */
  private providers = new Map<string, LLMProvider>();

  /**
   * 注册 LLM Provider
   */
  register(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
    console.log(`[LLMRouter] Registered provider "${provider.name}" with models: ${provider.models.join(', ')}`);
  }

  /**
   * 注销 LLM Provider
   */
  unregister(name: string): void {
    this.providers.delete(name);
  }

  /**
   * 获取 Provider
   */
  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * 列出所有已注册的模型
   */
  listModels(): string[] {
    const models: string[] = [];
    for (const provider of this.providers.values()) {
      models.push(...provider.models);
    }
    return models;
  }

  /**
   * 列出所有已注册的 provider 名称
   */
  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * 对所有 provider 执行健康检查
   */
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
