/**
 * Autonomous Subsystem — ModelResolver
 *
 * 解析 think.model 配置为实际的 provider + model。
 * 支持三种格式：级别名（mini/standard/pro）、provider/model、裸模型名。
 * 级别名模式支持 primary + fallback 降级链。
 *
 * 语义约定：
 * - `provider` 为 undefined = 不指名 provider（用主 provider 实例）
 * - `model` 为 undefined = 不指名模型（用所选 provider 的 defaultModel）
 * - 级别名未在 levels 中配置时 **fail-loud**（报可操作错误），不用假缺省静默打错模型
 *
 * @module autonomous-subsystem/think/model-resolver
 */

import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { ModelLevelMap, ModelLevelConfig } from '../types.js';

// ── 解析结果 ──

/** 解析后的模型引用 */
export interface ResolvedModel {
  /** provider 名称；undefined = 主 provider */
  provider?: string;
  /** 模型名称；undefined = provider 的 defaultModel */
  model?: string;
}

/** 带 fallback 的解析结果 */
export interface ResolvedModelWithFallback {
  /** 主模型 */
  primary: ResolvedModel;
  /** 降级链（按优先级排列） */
  fallback: ResolvedModel[];
  /** 是否来自级别名（有 fallback 支持） */
  fromLevel: boolean;
}

// ── ModelResolver 配置 ──

export interface ModelResolverConfig {
  /** 模型级别映射表（config.models.level） */
  levels: ModelLevelMap;
}

/** 产品约定的级别名（init/example/docs 均定义 mini/standard/pro；summary 为保留别名——历史上曾是摘要档，保留只为把误写的档位名 fail-loud，而不是当模型名发给 provider） */
const WELLKNOWN_LEVEL_ALIASES = new Set(['summary', 'mini', 'standard', 'pro']);

/**
 * 按解析结果选择 provider 实例
 *
 * @param resolved - 解析出的模型引用
 * @param providers - 按名注册的 provider 映射（可空）
 * @param fallback - 主 provider 实例（未指名 / 未命中时使用）
 * @returns provider 实例；指名未命中时回退 fallback 并告警
 */
export function resolveProviderInstance(
  resolved: ResolvedModel,
  providers: Map<string, ModelProvider> | undefined,
  fallback: ModelProvider,
): ModelProvider {
  if (!resolved.provider) return fallback;
  const named = providers?.get(resolved.provider);
  if (named) return named;
  // 未注册名回退主 provider 是拍板的 fail-open 策略（docs §7.4）；告警按名去重防逐调用刷屏
  if (!warnedProviderNames.has(resolved.provider)) {
    warnedProviderNames.add(resolved.provider);
    console.warn(
      `[SubsystemThink] provider "${resolved.provider}" not registered; falling back to main provider`,
    );
  }
  return fallback;
}

/** 已告警过的未注册 provider 名（每进程每名一次） */
const warnedProviderNames = new Set<string>();

/**
 * ModelResolver — 模型分级解析器
 *
 * 将子系统的 think.model 配置解析为实际的 provider + model。
 * 解析优先级：级别名 > provider/model > 裸模型名
 */
export class ModelResolver {
  private levels: ModelLevelMap;

  constructor(config: ModelResolverConfig) {
    this.levels = config.levels;
  }

  /**
   * 解析模型引用
   *
   * @param modelRef - 模型引用字符串（如 "mini"、"openai-main/gpt-4o-mini"、"gpt-4o-mini"）
   * @returns 带 fallback 的解析结果
   * @throws 级别名未配置时抛出可操作错误
   */
  resolve(modelRef: string): ResolvedModelWithFallback {
    // 1. 尝试级别名
    const level = this.levels[modelRef];
    if (level) {
      return this.resolveLevel(modelRef, level);
    }
    if (WELLKNOWN_LEVEL_ALIASES.has(modelRef)) {
      throw new Error(
        `unresolved_model_level: "${modelRef}" is not configured in models.level ` +
          `(configured: ${Object.keys(this.levels).join(', ') || 'none'})`,
      );
    }

    // 2. 尝试 provider/model 格式
    const slashIdx = modelRef.indexOf('/');
    if (slashIdx > 0) {
      const provider = modelRef.slice(0, slashIdx);
      const model = modelRef.slice(slashIdx + 1);
      return {
        primary: { provider, model },
        fallback: [],
        fromLevel: false,
      };
    }

    // 3. 裸模型名：主 provider + 显式模型名
    return {
      primary: { provider: undefined, model: modelRef },
      fallback: [],
      fromLevel: false,
    };
  }

  /**
   * 解析可缺省的模型引用
   *
   * - 显式 modelRef → 同 {@link resolve}（未配置级别名 fail-loud）
   * - 缺省 → 'standard' 级别（若已配置），否则主 provider 缺省模型
   *
   * @param modelRef - 可选模型引用
   * @returns 带 fallback 的解析结果
   */
  resolveRef(modelRef?: string): ResolvedModelWithFallback {
    if (modelRef) return this.resolve(modelRef);
    const standard = this.levels['standard'];
    if (standard) return this.resolveLevel('standard', standard);
    return { primary: { provider: undefined, model: undefined }, fallback: [], fromLevel: false };
  }

  /**
   * 更新级别映射（用于三级作用域合并）
   *
   * @param levels - 要合并的级别映射
   */
  updateLevels(levels: ModelLevelMap): void {
    this.levels = { ...this.levels, ...levels };
  }

  /**
   * 获取所有已配置的级别名
   *
   * @returns 级别名数组
   */
  get levelNames(): string[] {
    return Object.keys(this.levels);
  }

  // ── 内部方法 ──

  private resolveLevel(name: string, level: ModelLevelConfig): ResolvedModelWithFallback {
    const primary = this.parseModelRef(level.primary);
    const fallback = (level.fallback ?? []).map((ref) => this.parseModelRef(ref));

    return {
      primary,
      fallback,
      fromLevel: true,
    };
  }

  /**
   * 解析 "provider/model" 格式；无 provider 段时返回裸模型名引用
   */
  private parseModelRef(ref: string): ResolvedModel {
    const slashIdx = ref.indexOf('/');
    if (slashIdx <= 0) {
      return { provider: undefined, model: ref };
    }
    return {
      provider: ref.slice(0, slashIdx),
      model: ref.slice(slashIdx + 1),
    };
  }
}
