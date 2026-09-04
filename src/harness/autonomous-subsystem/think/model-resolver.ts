/**
 * Autonomous Subsystem — ModelResolver
 *
 * 解析 think.model 配置为实际的 provider + model。
 * 支持三种格式：级别名（mini/standard/pro）、provider/model、裸模型名。
 * 级别名模式支持 primary + fallback 降级链。
 *
 * @module autonomous-subsystem/think/model-resolver
 */

import type { ModelLevelMap, ModelLevelConfig } from '../types.js';

// ── 解析结果 ──

/** 解析后的模型引用 */
export interface ResolvedModel {
  /** provider 名称 */
  provider: string;
  /** 模型名称 */
  model: string;
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
  /** 模型级别映射表 */
  levels: ModelLevelMap;
  /** 默认 provider（裸模型名时使用） */
  defaultProvider?: string;
}

/**
 * ModelResolver — 模型分级解析器
 *
 * 将子系统的 think.model 配置解析为实际的 provider + model。
 * 解析优先级：级别名 > provider/model > 裸模型名
 */
export class ModelResolver {
  private levels: ModelLevelMap;
  private defaultProvider: string;

  constructor(config: ModelResolverConfig) {
    this.levels = config.levels;
    this.defaultProvider = config.defaultProvider ?? 'default';
  }

  /**
   * 解析模型引用
   *
   * @param modelRef - 模型引用字符串（如 "mini"、"openai-main/gpt-4o-mini"、"gpt-4o-mini"）
   * @returns 带 fallback 的解析结果
   * @throws 解析失败时抛出错误
   */
  resolve(modelRef: string): ResolvedModelWithFallback {
    // 1. 尝试级别名
    const level = this.levels[modelRef];
    if (level) {
      return this.resolveLevel(modelRef, level);
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

    // 3. 裸模型名，使用默认 provider
    return {
      primary: { provider: this.defaultProvider, model: modelRef },
      fallback: [],
      fromLevel: false,
    };
  }

  /**
   * 更新级别映射（用于三级作用域合并）
   */
  updateLevels(levels: ModelLevelMap): void {
    this.levels = { ...this.levels, ...levels };
  }

  /**
   * 获取所有已配置的级别名
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
   * 解析 "provider/model" 格式
   */
  private parseModelRef(ref: string): ResolvedModel {
    const slashIdx = ref.indexOf('/');
    if (slashIdx <= 0) {
      return { provider: this.defaultProvider, model: ref };
    }
    return {
      provider: ref.slice(0, slashIdx),
      model: ref.slice(slashIdx + 1),
    };
  }
}
