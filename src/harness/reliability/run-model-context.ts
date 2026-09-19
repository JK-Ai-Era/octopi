/**
 * Run 级模型上下文 — 兼容层
 *
 * 实现已收口至 `harness/model/run-scope`（只传 ResolvedModel）。
 *
 * @module harness/reliability/run-model-context
 */

import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type { ResolvedModel } from '../model/types.js';
import {
  withResolvedModel,
  getResolvedModel,
  getRunModelProvider,
  getRunContextWindow,
  getRunModelName,
} from '../model/run-scope.js';

export {
  withResolvedModel,
  getResolvedModel,
  getRunModelProvider,
  getRunContextWindow,
  getRunModelName,
};

/**
 * 兼容旧签名：provider + 可选 contextWindow → ResolvedModel
 *
 * 新代码请使用 `withResolvedModel(snapshot, gen)`。
 * contextWindow 未传时为未知（undefined），不猜测。
 */
export async function* withRunModel<T>(
  provider: ModelProvider | undefined,
  gen: AsyncGenerator<T>,
  extras?: { contextWindow?: number },
): AsyncGenerator<T> {
  if (!provider) {
    yield* gen;
    return;
  }
  const snapshot: ResolvedModel = {
    ref: `${provider.name}/${provider.defaultModel ?? ''}`,
    providerName: provider.name,
    modelName: provider.defaultModel ?? '',
    provider,
    contextWindow: extras?.contextWindow,
    source: extras?.contextWindow != null ? 'config' : 'unknown',
    known: extras?.contextWindow != null,
    isOverride: false,
  };
  yield* withResolvedModel(snapshot, gen);
}
