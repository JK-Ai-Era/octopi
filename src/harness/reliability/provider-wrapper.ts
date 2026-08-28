/**
 * Provider 包装工具
 *
 * 提供类型安全的 ModelProvider 包装，用于在不修改原始 provider 的情况下
 * 添加横切关注点（熔断、日志、重试等）。
 *
 * 设计原则：
 * - 使用 Proxy 转发所有属性，保证接口完整性
 * - 不用手工构造对象 + as 强转，避免遗漏方法
 * - 类型由 TypeScript 自动推导，不需要手动标注
 *
 * @module
 */

import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type { CircuitBreaker } from './circuit-breaker.js';

/**
 * 用熔断器包装 ModelProvider
 *
 * 只拦截 chat() 和 stream() 做熔断检查，其余属性（包括 getModelInfo、
 * getModelInfos、defaultModel 等）透传到原始 provider。
 *
 * @param provider - 原始 provider
 * @param cb - 熔断器实例
 * @returns 包装后的 provider（类型安全，接口完整）
 */
export function wrapProviderWithCircuitBreaker(
  provider: ModelProvider,
  cb: CircuitBreaker,
): ModelProvider {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === 'chat' && target.chat) {
        return async (request: any) => {
          if (!cb.allowRequest()) {
            throw new Error(`Circuit breaker open for provider "${target.name}". Too many consecutive failures.`);
          }
          try {
            const result = await target.chat!(request);
            cb.recordSuccess();
            return result;
          } catch (err) {
            cb.recordFailure();
            throw err;
          }
        };
      }
      if (prop === 'stream' && target.stream) {
        return async function* (request: any) {
          if (!cb.allowRequest()) {
            throw new Error(`Circuit breaker open for provider "${target.name}". Too many consecutive failures.`);
          }
          try {
            yield* target.stream!(request);
            cb.recordSuccess();
          } catch (err) {
            cb.recordFailure();
            throw err;
          }
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}


