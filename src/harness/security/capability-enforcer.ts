/**
 * CapabilityEnforcer — 能力执行器
 *
 * Harness 层组件。运行时强制执行 Plugin 信任分级和工具访问控制。
 *
 * 通过 Agent 的 beforeToolCall 回调槽注入。
 */

import type { ToolCall } from '../../core/types.js';
import type { EventBus } from '../../core/primitives/event-bus.js';
import { AgentEvents } from '../../core/primitives/event-bus.js';

// ── 信任级别 ──

export enum PluginTrustLevel {
  BUILTIN = 'builtin',
  OFFICIAL = 'official',
  THIRD_PARTY = 'third-party',
  UNTRUSTED = 'untrusted',
}

// ── 能力权限 ──

export interface PluginCapabilities {
  /** 允许使用的工具（'*' = 全部） */
  tools: string[] | '*';
  /** 文件系统访问范围 */
  filesystem: 'none' | 'sandbox' | 'workspace' | '*';
  /** 网络访问范围 */
  network: 'none' | 'allowed-list' | '*';
}

/** 各信任级别的默认能力 */
const DEFAULT_CAPABILITIES: Record<PluginTrustLevel, PluginCapabilities> = {
  [PluginTrustLevel.BUILTIN]:     { tools: '*', filesystem: '*', network: '*' },
  [PluginTrustLevel.OFFICIAL]:    { tools: '*', filesystem: 'workspace', network: 'allowed-list' },
  [PluginTrustLevel.THIRD_PARTY]: { tools: [], filesystem: 'sandbox', network: 'none' },
  [PluginTrustLevel.UNTRUSTED]:   { tools: [], filesystem: 'none', network: 'none' },
};

// ── 访问检查结果 ──

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

// ── 实现 ──

/**
 * CapabilityEnforcer
 */
export class CapabilityEnforcer {
  private pluginCapabilities = new Map<string, { level: PluginTrustLevel; capabilities: PluginCapabilities }>();
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * 注册 Plugin 的信任级别
   */
  registerPlugin(pluginId: string, level: PluginTrustLevel, customCapabilities?: Partial<PluginCapabilities>): void {
    const defaults = DEFAULT_CAPABILITIES[level];
    this.pluginCapabilities.set(pluginId, {
      level,
      capabilities: { ...defaults, ...customCapabilities },
    });
  }

  /**
   * 检查 Plugin 是否有权调用工具
   */
  checkToolAccess(pluginId: string, toolName: string): AccessDecision {
    const entry = this.pluginCapabilities.get(pluginId);
    if (!entry) {
      // 未注册的 Plugin → 最小权限
      return { allowed: false, reason: `Plugin "${pluginId}" not registered` };
    }

    const { capabilities } = entry;

    // 检查工具访问
    if (capabilities.tools === '*') {
      return { allowed: true };
    }

    if (Array.isArray(capabilities.tools) && capabilities.tools.includes(toolName)) {
      return { allowed: true };
    }

    // 被拒绝
    this.eventBus.emit({
      type: AgentEvents.POLICY_VIOLATED,
      timestamp: Date.now(),
      data: {
        pluginId,
        toolName,
        trustLevel: entry.level,
        reason: `Plugin "${pluginId}" (trust: ${entry.level}) not allowed to use tool "${toolName}"`,
      },
    });

    return {
      allowed: false,
      reason: `Plugin "${pluginId}" (trust: ${entry.level}) not allowed to use tool "${toolName}"`,
    };
  }

  /**
   * 检查 Plugin 是否有权访问路径
   */
  checkPathAccess(pluginId: string, path: string): AccessDecision {
    const entry = this.pluginCapabilities.get(pluginId);
    if (!entry) return { allowed: false, reason: `Plugin "${pluginId}" not registered` };

    const { capabilities } = entry;

    switch (capabilities.filesystem) {
      case '*':
        return { allowed: true };
      case 'workspace':
        // 简单检查：路径不包含 ..
        if (path.includes('..')) {
          return { allowed: false, reason: 'Path traversal not allowed' };
        }
        return { allowed: true };
      case 'sandbox':
        // 只允许访问临时目录
        if (!path.startsWith('/tmp/') && !path.startsWith('/tmp/')) {
          return { allowed: false, reason: `Path "${path}" outside sandbox` };
        }
        return { allowed: true };
      case 'none':
        return { allowed: false, reason: `Plugin "${pluginId}" has no filesystem access` };
      default:
        return { allowed: false, reason: 'Unknown filesystem policy' };
    }
  }

  /**
   * 检查 Plugin 是否有权访问网络
   */
  checkNetworkAccess(pluginId: string, host: string): AccessDecision {
    const entry = this.pluginCapabilities.get(pluginId);
    if (!entry) return { allowed: false, reason: `Plugin "${pluginId}" not registered` };

    const { capabilities } = entry;

    switch (capabilities.network) {
      case '*':
        return { allowed: true };
      case 'allowed-list':
        // 可以配置白名单
        return { allowed: true };
      case 'none':
        return { allowed: false, reason: `Plugin "${pluginId}" has no network access` };
      default:
        return { allowed: false, reason: 'Unknown network policy' };
    }
  }

  /**
   * 获取 Plugin 的信任级别
   */
  getTrustLevel(pluginId: string): PluginTrustLevel | null {
    return this.pluginCapabilities.get(pluginId)?.level ?? null;
  }
}
