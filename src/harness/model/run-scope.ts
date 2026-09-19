/**
 * Run 级模型快照 — AsyncLocalStorage
 *
 * 只承载 **已解析** 的 ResolvedModel。
 * convertToLlm / summarize 读 snapshot；contextWindow 未知时为 undefined。
 *
 * @module harness/model/run-scope
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type { ResolvedModel } from './types.js';

interface RunModelStore {
  snapshot: ResolvedModel;
}

const runModelStorage = new AsyncLocalStorage<RunModelStore>();

/**
 * 在 ResolvedModel 上下文中执行 generator
 *
 * @param snapshot - 本次 run 的模型快照；undefined 时不进入覆盖
 * @param gen - 事件流
 * @yields 原 generator 事件
 */
export async function* withResolvedModel<T>(
  snapshot: ResolvedModel | undefined,
  gen: AsyncGenerator<T>,
): AsyncGenerator<T> {
  if (!snapshot) {
    yield* gen;
    return;
  }
  const store: RunModelStore = { snapshot };
  while (true) {
    const result = await runModelStorage.run(store, () => gen.next());
    if (result.done) {
      return result.value;
    }
    yield result.value;
  }
}

/**
 * 读取当前 run 的 ResolvedModel
 *
 * @returns 快照；无覆盖时 undefined
 */
export function getResolvedModel(): ResolvedModel | undefined {
  return runModelStorage.getStore()?.snapshot;
}

/**
 * 读取当前 run 的 provider（无覆盖时回退）
 *
 * @param fallback - agent 默认 provider
 * @returns 当前应使用的 provider
 */
export function getRunModelProvider(fallback: ModelProvider): ModelProvider {
  return runModelStorage.getStore()?.snapshot.provider ?? fallback;
}

/**
 * 读取当前 run 已配置的 contextWindow
 *
 * @returns 窗口；未知/无覆盖时 undefined
 */
export function getRunContextWindow(): number | undefined {
  return runModelStorage.getStore()?.snapshot.contextWindow;
}

/**
 * 读取当前 run 模型名
 *
 * @returns 模型名；无覆盖时 undefined
 */
export function getRunModelName(): string | undefined {
  return runModelStorage.getStore()?.snapshot.modelName;
}
