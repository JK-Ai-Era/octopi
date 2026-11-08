/**
 * ResolvedModel — run/catalog 级模型快照
 *
 * contextWindow 来自显式配置，或 provider 测量回填（长度类 400 报告的真值），
 * 或 400 后的 run 级收缩上界；三者皆无时为 undefined（未知），下游禁止用
 * builtin/默认值「猜」窗口。
 *
 * @module harness/run/model/types
 */

import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { ModelInputType } from '@octopi-agent/core/types/agent-definition.js';

/**
 * contextWindow / maxTokens 的声明来源
 *
 * `config`：显式配置（models.providers[].models[] / agent.model）；
 * `measured`：provider 长度类 400 错误文本报告的窗口真值（F 类回填，见
 * window-truth.ts）——测量优先于预测；
 * `shrunk`：长度类 400 后的收缩上界（run 级保守猜测，非持久真值）；
 * `unknown`：两者皆无（不猜测）。
 */
export type ModelCapabilitySource =
  | 'config'
  | 'measured'
  | 'shrunk'
  | 'unknown';

/**
 * 已解析模型快照
 *
 * 不变量：
 * - `contextWindow` 有值 ⇔ `known === true`；来源见 `source`（config 显式配置 /
 *   measured provider 窗口真值 / shrunk run 级收缩上界）
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
  /** 能力声明（models.providers[].models[] 透传；未声明不猜测） */
  reasoning?: boolean;
  input?: ModelInputType[];
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
  /** 能力声明（models.providers[].models[] 透传；未声明不猜测） */
  reasoning?: boolean;
  input?: ModelInputType[];
  known: boolean;
  source: ModelCapabilitySource;
}
