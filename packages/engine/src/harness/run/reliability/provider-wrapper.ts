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

import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { CircuitBreaker } from './circuit-breaker.js';

/**
 * 判定错误是否属于「取消/中止」而非「节点故障」
 *
 * 两类来源：(1) 调用方主动 abort（用户停止、run 取消）；
 * (2) 回退链的单节点预算耗尽 —— 它 abort 的是子 signal，节点本身可能只是慢。
 * 二者都不应累计熔断失败数，否则健康节点会被连续 5 次「慢」直接熔断。
 *
 * @param err - provider 抛出的错误
 * @param signal - 该次请求的 signal
 * @returns 是否为取消类
 */
function isCancellationLike(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'AbortError') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /abort/i.test(message);
}

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
            // abort / 预算类错误不计入熔断：节点只是「慢」或「被取消」，
            // 把它当故障会误伤健康节点（连续 5 次即熔断，随后只剩 unknown 错误）。
            if (!isCancellationLike(err, request.signal)) cb.recordFailure();
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
            // 同 chat：取消/预算类错误不是节点故障
            if (!isCancellationLike(err, request.signal)) cb.recordFailure();
            throw err;
          }
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}


