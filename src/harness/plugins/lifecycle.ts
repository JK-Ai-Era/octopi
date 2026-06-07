/**
 * Plugin 生命周期管理 — 扩展 PluginManager
 *
 * 为 PluginManager 添加完整的生命周期管理能力：
 * - PluginState 状态机
 * - activate / suspend / resume / unload 方法
 * - 状态查询
 */

import type { LoadedPlugin } from './loader.js';

/** Plugin 状态 */
export type PluginState =
  | 'discovered'    // 已发现
  | 'loaded'        // 已加载
  | 'activated'     // 已激活
  | 'suspended'     // 已暂停
  | 'deactivated'   // 已停用
  | 'unloaded'      // 已卸载
  | 'error';        // 错误状态

/** Plugin 条目（带状态） */
export interface PluginEntry {
  /** Plugin ID */
  id: string;
  /** 当前状态 */
  state: PluginState;
  /** 加载时间 */
  loadedAt?: number;
  /** 激活时间 */
  activatedAt?: number;
  /** 错误信息 */
  error?: Error;
  /** 扩展元数据 */
  metadata: Record<string, unknown>;
}

/** Plugin 生命周期管理器 */
export class PluginLifecycleManager {
  /** Plugin 状态映射 */
  private states: Map<string, PluginEntry> = new Map();

  /**
   * 注册 Plugin（发现后调用）
   */
  register(pluginId: string): void {
    if (!this.states.has(pluginId)) {
      this.states.set(pluginId, {
        id: pluginId,
        state: 'discovered',
        metadata: {},
      });
    }
  }

  /**
   * 标记为已加载
   */
  markLoaded(pluginId: string): void {
    const entry = this.getOrCreate(pluginId);
    entry.state = 'loaded';
    entry.loadedAt = Date.now();
  }

  /**
   * 激活 Plugin
   */
  activate(pluginId: string): void {
    const entry = this.getOrCreate(pluginId);
    if (entry.state === 'unloaded') {
      throw new Error(`Cannot activate unloaded plugin "${pluginId}"`);
    }
    entry.state = 'activated';
    entry.activatedAt = Date.now();
    entry.error = undefined;
  }

  /**
   * 暂停 Plugin
   */
  suspend(pluginId: string): void {
    const entry = this.getEntry(pluginId);
    if (!entry || entry.state !== 'activated') {
      throw new Error(`Plugin "${pluginId}" is not activated`);
    }
    entry.state = 'suspended';
  }

  /**
   * 恢复 Plugin
   */
  resume(pluginId: string): void {
    const entry = this.getEntry(pluginId);
    if (!entry || entry.state !== 'suspended') {
      throw new Error(`Plugin "${pluginId}" is not suspended`);
    }
    entry.state = 'activated';
  }

  /**
   * 停用 Plugin
   */
  deactivate(pluginId: string): void {
    const entry = this.getEntry(pluginId);
    if (!entry) throw new Error(`Plugin "${pluginId}" not found`);
    if (entry.state !== 'activated' && entry.state !== 'suspended') {
      throw new Error(`Plugin "${pluginId}" is not activated or suspended`);
    }
    entry.state = 'deactivated';
  }

  /**
   * 卸载 Plugin
   */
  unload(pluginId: string): void {
    const entry = this.getEntry(pluginId);
    if (!entry) throw new Error(`Plugin "${pluginId}" not found`);
    entry.state = 'unloaded';
  }

  /**
   * 标记错误
   */
  markError(pluginId: string, error: Error): void {
    const entry = this.getOrCreate(pluginId);
    entry.state = 'error';
    entry.error = error;
  }

  /**
   * 获取 Plugin 状态
   */
  getState(pluginId: string): PluginState {
    return this.states.get(pluginId)?.state ?? 'unloaded';
  }

  /**
   * 获取 Plugin 条目
   */
  getEntry(pluginId: string): PluginEntry | undefined {
    return this.states.get(pluginId);
  }

  /**
   * 获取所有 Plugin 状态
   */
  listStates(): PluginEntry[] {
    return Array.from(this.states.values());
  }

  /**
   * 检查 Plugin 是否激活
   */
  isActivated(pluginId: string): boolean {
    return this.getState(pluginId) === 'activated';
  }

  /**
   * 获取已激活的 Plugin ID 列表
   */
  getActivatedIds(): string[] {
    return this.listStates()
      .filter(entry => entry.state === 'activated')
      .map(entry => entry.id);
  }

  /**
   * 获取或创建条目
   */
  private getOrCreate(pluginId: string): PluginEntry {
    if (!this.states.has(pluginId)) {
      this.states.set(pluginId, {
        id: pluginId,
        state: 'discovered',
        metadata: {},
      });
    }
    return this.states.get(pluginId)!;
  }
}
