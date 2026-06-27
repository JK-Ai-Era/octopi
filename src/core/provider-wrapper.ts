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

import type { ModelProvider } from './interfaces/model-provider.js';
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

/**
 * 运行时检查对象是否实现了 ModelProvider 接口的关键方法
 *
 * 用于在构造 provider 后验证完整性，作为编译时检查的补充。
 * 在测试和初始化路径中使用。
 */
export function assertModelProvider(obj: unknown, label = 'provider'): asserts obj is ModelProvider {
  if (!obj || typeof obj !== 'object') {
    throw new Error(`[${label}] Expected an object, got ${typeof obj}`);
  }
  const p = obj as Record<string, unknown>;
  if (typeof p.getModelInfo !== 'function') {
    throw new Error(`[${label}] Missing required method: getModelInfo`);
  }
  if (typeof p.getModelInfos !== 'function') {
    throw new Error(`[${label}] Missing required method: getModelInfos`);
  }
  // chat 和 stream 是可选的（provider 可能只支持其中一种）
}
