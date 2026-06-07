/**
 * Capability Registry — 能力注册中心
 *
 * 对齐 OpenClaw 的 capability ownership model。
 * 每种能力类型有独立的注册表，plugin 是能力的所有权边界。
 *
 * 核心原则：
 * - plugin = 所有权边界（一个公司/功能的所有表面）
 * - capability = 核心合约，多个 plugin 可以实现或消费
 * - 冲突检测：同一 capability ID 不能被两个 plugin 注册
 *
 * 参考: https://docs.openclaw.ai/plugins/architecture#capability-ownership-model
 */

import type { LLMProvider, ChannelAdapter, ContextEngine } from '../core/types.js';
import type { PluginManifest } from './manifest.js';

/**
 * 能力类型枚举
 */
export type CapabilityType =
  | 'provider'
  | 'channel'
  | 'tool'
  | 'context-engine'
  | 'embedding-provider'
  | 'speech-provider'
  | 'media-understanding-provider'
  | 'image-generation-provider'
  | 'video-generation-provider'
  | 'web-search-provider'
  | 'web-fetch-provider'
  | 'service'
  | 'command';

/**
 * 能力注册记录
 */
export interface CapabilityRecord {
  /** 能力类型 */
  type: CapabilityType;
  /** 能力 ID（如 provider name、tool name、channel id） */
  capabilityId: string;
  /** 拥有者 plugin ID */
  pluginId: string;
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * Capability Registry
 *
 * 中央能力注册中心。所有 plugin 注册的能力都在这里记录，
 * 用于冲突检测、ownership 查询和诊断。
 */
export class CapabilityRegistry {
  /** 所有能力记录 */
  private records: CapabilityRecord[] = [];

  /** 索引：type:capabilityId → record */
  private index = new Map<string, CapabilityRecord>();

  /**
   * 注册一个能力
   *
   * @param type - 能力类型
   * @param capabilityId - 能力 ID
   * @param pluginId - 拥有者 plugin ID
   * @param metadata - 额外元数据
   * @throws 如果能力已被另一个 plugin 注册
   */
  register(
    type: CapabilityType,
    capabilityId: string,
    pluginId: string,
    metadata?: Record<string, unknown>,
  ): void {
    const key = `${type}:${capabilityId}`;
    const existing = this.index.get(key);

    if (existing && existing.pluginId !== pluginId) {
      throw new Error(
        `Capability conflict: "${type}:${capabilityId}" is already registered by plugin "${existing.pluginId}", ` +
        `cannot register from plugin "${pluginId}"`,
      );
    }

    if (existing) {
      // 同一 plugin 重复注册，静默忽略
      return;
    }

    const record: CapabilityRecord = { type, capabilityId, pluginId, metadata };
    this.records.push(record);
    this.index.set(key, record);
  }

  /**
   * 查询能力的拥有者
   *
   * @param type - 能力类型
   * @param capabilityId - 能力 ID
   * @returns 拥有者 plugin ID，未注册返回 null
   */
  lookup(type: CapabilityType, capabilityId: string): string | null {
    const key = `${type}:${capabilityId}`;
    return this.index.get(key)?.pluginId ?? null;
  }

  /**
   * 查询指定 plugin 拥有的所有能力
   *
   * @param pluginId - Plugin ID
   * @returns 能力记录列表
   */
  getCapabilitiesForPlugin(pluginId: string): CapabilityRecord[] {
    return this.records.filter((r) => r.pluginId === pluginId);
  }

  /**
   * 查询指定类型的所有能力
   *
   * @param type - 能力类型
   * @returns 能力记录列表
   */
  getCapabilitiesByType(type: CapabilityType): CapabilityRecord[] {
    return this.records.filter((r) => r.type === type);
  }

  /**
   * 移除指定 plugin 的所有能力
   *
   * @param pluginId - Plugin ID
   */
  unregisterPlugin(pluginId: string): void {
    this.records = this.records.filter((r) => {
      if (r.pluginId === pluginId) {
        const key = `${r.type}:${r.capabilityId}`;
        this.index.delete(key);
        return false;
      }
      return true;
    });
  }

  /**
   * 获取所有注册记录（用于诊断）
   */
  getAll(): CapabilityRecord[] {
    return [...this.records];
  }

  /**
   * 获取能力总数
   */
  get size(): number {
    return this.records.length;
  }

  /**
   * 检查能力是否已注册
   */
  has(type: CapabilityType, capabilityId: string): boolean {
    return this.index.has(`${type}:${capabilityId}`);
  }
}

/**
 * 从 manifest 提取能力声明并注册到 CapabilityRegistry
 *
 * @param manifest - Plugin manifest
 * @param registry - Capability Registry
 */
export function registerManifestCapabilities(
  manifest: PluginManifest,
  registry: CapabilityRegistry,
): void {
  const pluginId = manifest.id;

  // 注册 providers
  if (manifest.providers) {
    for (const providerId of manifest.providers) {
      registry.register('provider', providerId, pluginId);
    }
  }

  // 注册 channels
  if (manifest.channels) {
    for (const channelId of manifest.channels) {
      registry.register('channel', channelId, pluginId);
    }
  }

  // 注册 contracts.tools
  if (manifest.contracts?.tools) {
    for (const toolName of manifest.contracts.tools) {
      registry.register('tool', toolName, pluginId);
    }
  }

  // 注册 contracts 中的其他能力
  const contractTypes: Array<{ key: keyof NonNullable<PluginManifest['contracts']>; type: CapabilityType }> = [
    { key: 'embeddingProviders', type: 'embedding-provider' },
    { key: 'speechProviders', type: 'speech-provider' },
    { key: 'mediaUnderstandingProviders', type: 'media-understanding-provider' },
    { key: 'imageGenerationProviders', type: 'image-generation-provider' },
    { key: 'videoGenerationProviders', type: 'video-generation-provider' },
    { key: 'webFetchProviders', type: 'web-fetch-provider' },
    { key: 'webSearchProviders', type: 'web-search-provider' },
  ];

  if (manifest.contracts) {
    for (const { key, type } of contractTypes) {
      const ids = manifest.contracts[key] as string[] | undefined;
      if (ids) {
        for (const id of ids) {
          registry.register(type, id, pluginId);
        }
      }
    }
  }
}
