/**
 * 模型绑定工具 — 兼容层
 *
 * 策略实现已收口至 `harness/model`。
 * contextWindow **不**使用 builtin/产品默认猜测。
 *
 * @module harness/reliability/model-binding
 */

export {
  parseModelRef,
  bindModelName,
  lookupDeclaredContextWindow,
  lookupModelCapability,
  resolveModel,
  resolveModelRef,
  resolveCatalogEntry,
} from '../model/index.js';
export type { ParsedModelRef, ResolvedModel } from '../model/index.js';

import { bindModelName, parseModelRef } from '../model/index.js';
import type { ModelProvider } from '../../core/interfaces/model-provider.js';

/**
 * 解析模型引用并绑定到 provider 表
 *
 * @param modelRef - `provider/model` 或裸模型名
 * @param providers - provider 名 → 实例
 * @param options - 解析选项
 * @returns 绑定后的 provider；找不到时返回 null
 */
export function bindModelRef(
  modelRef: string,
  providers: ReadonlyMap<string, ModelProvider>,
  options?: { defaultProvider?: string },
): ModelProvider | null {
  const parsed = parseModelRef(modelRef, options?.defaultProvider);
  if (!parsed.provider) return null;
  const provider = providers.get(parsed.provider);
  if (!provider) return null;
  return bindModelName(provider, parsed.model);
}
