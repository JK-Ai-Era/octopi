/**
 * ResolvedModel — run/catalog 级模型快照
 *
 * contextWindow **仅**来自显式配置；未配置时为 undefined（未知），
 * 下游禁止用 builtin/默认值「猜」窗口。
 *
 * @module harness/model/types
 */

import type { ModelProvider } from '../../core/interfaces/model-provider.js';

/** contextWindow / maxTokens 的声明来源 */
export type ModelCapabilitySource =
  | 'config'
  | 'unknown';

/**
 * 已解析模型快照
 *
 * 不变量：
 * - `contextWindow` 有值 ⇔ `known === true` ⇔ 来自配置
 * - `contextWindow === undefined` 时，基于窗口的自动压缩/预算截断必须跳过
 * - `provider` 已 `bindModelName`，`defaultModel === modelName`
 */
export interface ResolvedModel {
  /** 稳定 id：`provider/modelName` */
  ref: string;
  providerName: string;
  /** 发给 LLM API 的模型名 */
  modelName: string;
  /** 已绑定 modelName 的 provider 视图 */
  provider: ModelProvider;
  /** 显式配置的上下文窗口；未配置 = 未知 */
  contextWindow?: number;
  maxOutputTokens?: number;
  source: ModelCapabilitySource;
  /** contextWindow 是否来自显式配置 */
  known: boolean;
  /** 是否为会话/消息级覆盖（相对 agent 默认） */
  isOverride: boolean;
}

/** 目录条目（REST / WebUI） */
export interface ModelCatalogEntry {
  id: string;
  provider: string;
  model: string;
  /** 未配置时为 null */
  contextWindow: number | null;
  maxOutputTokens?: number;
  known: boolean;
  source: ModelCapabilitySource;
}
