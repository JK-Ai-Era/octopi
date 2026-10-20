/**
 * CapabilityEnforcer — 能力执行器
 *
 * Harness 层组件。运行时强制执行 Plugin 信任分级和工具访问控制。
 *
 * 通过 Agent 的 beforeToolCall 回调槽注入。
 */

import type { ToolCall } from '@octopi-agent/core/types.js';
import type { EventBus } from '@octopi-agent/core/primitives/event-bus.js';
import { resolve } from 'node:path';
import { AgentEvents } from '../../shared/events/agent-event-map.js';
import { isAbsolutePath, isTempPath, startsWithPathPrefix } from './temp-path.js';

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
   *
   * @param pluginId Plugin 标识（须先 registerPlugin）
   * @param path 待访问路径；`workspace` 语义下相对路径锚定 `opts.workspaceRoot`（不锚进程 cwd），`sandbox` 语义下要求绝对路径
   * @param opts workspaceRoot：`filesystem: 'workspace'` 的包含判定根；缺省 fail-closed
   * @returns 放行或拒绝（含原因）
   * @remarks 字符串级判定：不做 realpath，符号链接逃逸 / TOCTOU 不在本检查覆盖范围
   */
  checkPathAccess(pluginId: string, path: string, opts?: { workspaceRoot?: string }): AccessDecision {
    const entry = this.pluginCapabilities.get(pluginId);
    if (!entry) return { allowed: false, reason: `Plugin "${pluginId}" not registered` };

    const { capabilities } = entry;

    switch (capabilities.filesystem) {
      case '*':
        return { allowed: true };
      case 'workspace': {
        // 真实包含判定需要 workspace 根；根未知时 fail-closed（不装懂放行）
        const root = opts?.workspaceRoot;
        if (!root) {
          return { allowed: false, reason: `Cannot verify "${path}": workspace root unknown` };
        }
        // 相对路径锚定 workspace root；resolve 折叠 `..`，防 `ws/../etc/passwd` 穿越
        const resolvedRoot = resolve(root);
        const resolvedPath = resolve(root, path);
        // 段边界前缀匹配；Windows 风格路径大小写不敏感、分隔符归一（同 temp-path 匹配语义）
        if (!startsWithPathPrefix(resolvedPath, resolvedRoot)) {
          return { allowed: false, reason: `Path "${path}" outside workspace` };
        }
        return { allowed: true };
      }
      case 'sandbox': {
        // 只允许临时目录（isTempPath 单一来源）；相对路径无从锚定，fail-closed
        if (!isAbsolutePath(path)) {
          return { allowed: false, reason: `Path "${path}" must be absolute for sandbox access` };
        }
        // resolve 折叠 `..`，防 `/tmp/../etc/passwd` 穿越
        const resolved = resolve(path);
        if (!isTempPath(resolved)) {
          return { allowed: false, reason: `Path "${path}" outside sandbox` };
        }
        return { allowed: true };
      }
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
