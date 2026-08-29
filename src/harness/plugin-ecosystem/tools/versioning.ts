/**
 * Tool 版本管理 — 扩展 ToolRegistry
 *
 * 为 ToolRegistry 添加版本管理能力：
 * - 版本化工具注册
 * - 版本适配（旧格式 → 新格式）
 * - 废弃警告收集
 */

import type { RegisteredTool, ToolDefinition, ToolHandler, ToolExecutionContext } from '../../../core/types.js';

/** 版本化工具 */
export interface VersionedTool extends RegisteredTool {
  /** 工具版本 */
  version?: string;
  /** 是否废弃 */
  deprecated?: boolean;
  /** 废弃消息 */
  deprecatedMessage?: string;
  /** 将在哪个版本移除 */
  removedIn?: string;
  /** 迁移指南 */
  migrationGuide?: string;
  /** 向后兼容转换函数 */
  adaptCall?: (oldVersion: string, args: unknown) => unknown;
}

/** 废弃警告 */
export interface DeprecationWarning {
  /** 工具名称 */
  toolName: string;
  /** 当前版本 */
  currentVersion: string;
  /** 使用的版本 */
  usedVersion: string;
  /** 警告消息 */
  message: string;
  /** 迁移指南 */
  migrationGuide?: string;
  /** 发生时间 */
  timestamp: number;
}

/** 版本化工具注册表 */
export class VersionedToolRegistry {
  /** 全局工具 */
  private globalTools = new Map<string, VersionedTool>();
  /** Agent 级工具 */
  private agentTools = new Map<string, Map<string, VersionedTool>>();
  /** 版本历史 */
  private versionHistory = new Map<string, Map<string, VersionedTool>>();
  /** 废弃警告 */
  private deprecationWarnings: DeprecationWarning[] = [];

  /**
   * 注册工具
   */
  register(tool: VersionedTool, agentId?: string): void {
    const name = tool.definition.name;
    const version = tool.version;

    // 存储版本历史
    if (!this.versionHistory.has(name)) {
      this.versionHistory.set(name, new Map());
    }
    this.versionHistory.get(name)!.set(version ?? 'latest', tool);

    // 注册当前版本（覆盖）
    if (agentId) {
      if (!this.agentTools.has(agentId)) {
        this.agentTools.set(agentId, new Map());
      }
      this.agentTools.get(agentId)!.set(name, tool);
    } else {
      this.globalTools.set(name, tool);
    }
  }

  /**
   * 获取工具
   */
  get(name: string, agentId?: string): VersionedTool | undefined {
    if (agentId) {
      return this.agentTools.get(agentId)?.get(name) ?? this.globalTools.get(name);
    }
    return this.globalTools.get(name);
  }

  /**
   * 获取指定版本的工具
   */
  getVersion(name: string, version: string): VersionedTool | undefined {
    return this.versionHistory.get(name)?.get(version);
  }

  /**
   * 列出所有工具
   */
  list(): VersionedTool[] {
    return Array.from(this.globalTools.values());
  }

  /**
   * 执行工具（带版本适配）
   */
  async execute(
    name: string,
    args: unknown,
    ctx: ToolExecutionContext,
    requestedVersion?: string
  ): Promise<unknown> {
    const tool = this.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found`);
    }

    let adaptedArgs = args;

    // 版本适配
    if (requestedVersion && requestedVersion !== (tool.version ?? 'latest')) {
      if (tool.adaptCall) {
        adaptedArgs = tool.adaptCall(requestedVersion, args);
        this.addDeprecationWarning({
          toolName: name,
          currentVersion: tool.version ?? 'latest',
          usedVersion: requestedVersion,
          message: `Using old version ${requestedVersion}`,
          migrationGuide: tool.migrationGuide,
        });
      }
    }

    // 废弃检查
    if (tool.deprecated) {
      this.addDeprecationWarning({
        toolName: name,
        currentVersion: tool.version ?? 'latest',
        usedVersion: tool.version ?? 'latest',
        message: tool.deprecatedMessage ?? `Tool "${name}" is deprecated`,
        migrationGuide: tool.migrationGuide,
      });
    }

    return tool.handler(adaptedArgs as Record<string, unknown>, ctx);
  }

  /**
   * 获取废弃警告
   */
  getDeprecationWarnings(): DeprecationWarning[] {
    return [...this.deprecationWarnings];
  }

  /**
   * 清除废弃警告
   */
  clearDeprecationWarnings(): void {
    this.deprecationWarnings = [];
  }

  /**
   * 添加废弃警告（去重）
   */
  private addDeprecationWarning(warning: Omit<DeprecationWarning, 'timestamp'>): void {
    const exists = this.deprecationWarnings.some(
      w => w.toolName === warning.toolName && w.usedVersion === warning.usedVersion
    );
    if (!exists) {
      this.deprecationWarnings.push({
        ...warning,
        timestamp: Date.now(),
      });
    }
  }
}
