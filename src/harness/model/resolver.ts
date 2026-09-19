/**
 * ModelResolver — 模型绑定与能力解析的唯一策略入口
 *
 * 设计约定（架构收口，见 docs/architecture.md）：
 * 1. 每个 run / 每个 catalog 条目只 resolve 一次
 * 2. 下游只读 ResolvedModel，禁止二次回退
 * 3. **contextWindow 仅认显式配置**；未配置 = unknown，不猜测
 * 4. 会话覆盖到另一模型时，不继承 agent 默认模型的窗口
 *
 * @module harness/model/resolver
 */

import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type {
  ModelCatalogEntry,
  ModelCapabilitySource,
  ResolvedModel,
} from './types.js';

export interface ParsedModelRef {
  provider?: string;
  model: string;
}

/**
 * 解析 `provider/model` 或裸模型名
 *
 * @param modelRef - 模型引用
 * @param defaultProvider - 裸名时的 provider
 * @returns 解析结果
 */
export function parseModelRef(modelRef: string, defaultProvider?: string): ParsedModelRef {
  const slashIdx = modelRef.indexOf('/');
  if (slashIdx > 0) {
    return {
      provider: modelRef.slice(0, slashIdx),
      model: modelRef.slice(slashIdx + 1),
    };
  }
  return { provider: defaultProvider, model: modelRef };
}

/**
 * 将模型名绑定到 LLMRequest（不修改原 provider）
 *
 * @param provider - 原始 provider
 * @param model - 绑定的模型名
 * @returns 绑定后的 provider 视图
 */
export function bindModelName(provider: ModelProvider, model: string): ModelProvider {
  return {
    name: provider.name,
    defaultModel: model,
    getModelInfo: (modelName: string) => provider.getModelInfo(modelName),
    getModelInfos: () => provider.getModelInfos(),
    isAvailable: () => provider.isAvailable(),
    chat: (request) => provider.chat({ ...request, model: request.model ?? model }),
    stream: (request) => provider.stream({ ...request, model: request.model ?? model }),
  };
}

function positive(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 查询模型能力 — **只认显式配置**
 *
 * 来源：`explicit`（models.providers[].models[] / agent.model 写死的字段）
 * 与 provider ModelInfo（须由用户配置填充，不含 builtin 猜测）。
 * 未命中时 contextWindow 为 undefined。
 *
 * @param input - provider + 模型名 + 可选显式声明
 * @returns 能力；未配置时 known=false 且 contextWindow=undefined
 */
export function lookupModelCapability(input: {
  provider?: Pick<ModelProvider, 'getModelInfo'> | null;
  modelName?: string;
  explicit?: { contextWindow?: number; maxOutputTokens?: number };
}): {
  contextWindow?: number;
  maxOutputTokens?: number;
  source: ModelCapabilitySource;
  known: boolean;
} {
  const { provider, modelName, explicit } = input;

  // explicit（调用方带来的配置声明）优先
  const explicitWindow = positive(explicit?.contextWindow);
  if (explicitWindow) {
    return {
      contextWindow: explicitWindow,
      maxOutputTokens: positive(explicit?.maxOutputTokens),
      source: 'config',
      known: true,
    };
  }

  // provider ModelInfo（仅当构造 provider 时来自用户 models[] 配置）
  if (provider && modelName) {
    const info = provider.getModelInfo(modelName);
    const w = positive(info?.contextWindow);
    if (w) {
      return {
        contextWindow: w,
        maxOutputTokens: positive(info?.maxOutputTokens) ?? positive(explicit?.maxOutputTokens),
        source: 'config',
        known: true,
      };
    }
  }

  return {
    maxOutputTokens: positive(explicit?.maxOutputTokens),
    source: 'unknown',
    known: false,
  };
}

export interface ResolveModelInput {
  providerName: string;
  modelName: string;
  providers: ReadonlyMap<string, ModelProvider>;
  /** 显式能力声明（配置） */
  explicit?: { contextWindow?: number; maxOutputTokens?: number };
  /** 是否会话/消息级覆盖；覆盖时忽略 agent 级 explicit */
  isOverride?: boolean;
  wrapProvider?: (provider: ModelProvider, providerName: string) => ModelProvider;
}

/**
 * 解析并绑定模型 — 唯一策略函数
 *
 * contextWindow：仅 explicit / provider 配置 ModelInfo；否则 undefined（未知）。
 *
 * @param input - 解析输入
 * @returns ResolvedModel；provider 不存在时返回 null
 */
export function resolveModel(input: ResolveModelInput): ResolvedModel | null {
  const {
    providerName,
    modelName,
    providers,
    explicit,
    isOverride = false,
    wrapProvider,
  } = input;

  const raw = providers.get(providerName);
  if (!raw) return null;

  const explicitForThisModel = isOverride ? undefined : explicit;
  const cap = lookupModelCapability({
    provider: raw,
    modelName,
    explicit: explicitForThisModel,
  });

  const bound = bindModelName(raw, modelName);
  const provider = wrapProvider ? wrapProvider(bound, providerName) : bound;

  return {
    ref: `${providerName}/${modelName}`,
    providerName,
    modelName,
    provider,
    contextWindow: cap.contextWindow,
    maxOutputTokens: cap.maxOutputTokens,
    source: cap.known ? 'config' : 'unknown',
    known: cap.known,
    isOverride,
  };
}

/**
 * 从 modelRef 字符串解析
 *
 * @param modelRef - `provider/model` 或裸名
 * @param input - 其余 resolve 参数
 * @returns ResolvedModel 或 null
 */
export function resolveModelRef(
  modelRef: string,
  input: Omit<ResolveModelInput, 'providerName' | 'modelName'> & { defaultProvider?: string },
): ResolvedModel | null {
  const parsed = parseModelRef(modelRef, input.defaultProvider);
  if (!parsed.provider) return null;
  return resolveModel({
    ...input,
    providerName: parsed.provider,
    modelName: parsed.model,
  });
}

/**
 * 构造目录条目（catalog）— 与 resolveModel 同一能力链
 *
 * @param input - providerName + modelName + providers + optional explicit
 * @returns ModelCatalogEntry（contextWindow 可为 null）
 */
export function resolveCatalogEntry(input: {
  providerName: string;
  modelName: string;
  providers: ReadonlyMap<string, ModelProvider>;
  explicit?: { contextWindow?: number; maxOutputTokens?: number };
}): ModelCatalogEntry {
  const resolved = resolveModel({
    providerName: input.providerName,
    modelName: input.modelName,
    providers: input.providers,
    explicit: input.explicit,
    isOverride: false,
  });
  if (resolved) {
    return {
      id: resolved.ref,
      provider: resolved.providerName,
      model: resolved.modelName,
      contextWindow: resolved.contextWindow ?? null,
      maxOutputTokens: resolved.maxOutputTokens,
      known: resolved.known,
      source: resolved.source,
    };
  }
  const cap = lookupModelCapability({
    modelName: input.modelName,
    explicit: input.explicit,
  });
  return {
    id: `${input.providerName}/${input.modelName}`,
    provider: input.providerName,
    model: input.modelName,
    contextWindow: cap.contextWindow ?? null,
    maxOutputTokens: cap.maxOutputTokens,
    known: cap.known,
    source: cap.known ? 'config' : 'unknown',
  };
}

/**
 * 查询已声明的 contextWindow（未知返回 null）
 *
 * @param provider - provider
 * @param modelName - 模型名
 * @returns 窗口或 null
 */
export function lookupDeclaredContextWindow(
  provider: Pick<ModelProvider, 'getModelInfo'> | null | undefined,
  modelName: string | undefined,
): number | null {
  if (!modelName) return null;
  const w = positive(provider?.getModelInfo(modelName)?.contextWindow);
  return w ?? null;
}
