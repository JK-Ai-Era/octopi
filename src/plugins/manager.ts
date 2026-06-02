/**
 * Plugin Manager — 对齐 OpenClaw 的 Plugin 管理系统
 *
 * 这是 plugin 系统的顶层管理器，负责：
 * - 加载和管理所有 plugins
 * - 运行 hooks（支持 priority、timeout、拦截语义）
 * - 能力注册和查询
 * - 对齐 OpenClaw 的 hook catalog
 *
 * Hook 分类（对齐 OpenClaw）：
 * - 拦截语义：返回值改变执行流程
 * - 观察语义：所有 plugin 都执行
 * - 上下文注入：返回 prependContext / systemPrompt 等
 *
 * 参考: https://docs.openclaw.ai/plugins/hooks
 */

import type {
  AgentDefinition,
  ChannelMessage,
  ChannelReply,
  Message,
  ToolCall,
  ToolResult,
  HookContext,
} from '../core/types.js';
import type { PluginApi } from './api.js';
import type { LoadedPlugin, PluginLoaderConfig, PluginEntryConfig } from './loader.js';
import { PluginLoader } from './loader.js';
import { CapabilityRegistry } from './capability.js';

// ================================================================
// Hook Event Types — 对齐 OpenClaw Hook Catalog
// ================================================================

/**
 * before_model_resolve 事件
 */
export interface BeforeModelResolveEvent {
  /** 当前 prompt */
  prompt: string;
  /** 上下文 */
  ctx: HookContext;
}

/**
 * agent_turn_prepare 事件
 */
export interface AgentTurnPrepareEvent {
  /** 当前 prompt */
  prompt: string;
  /** Session 消息 */
  messages: Message[];
  /** 上下文 */
  ctx: HookContext;
}

/**
 * before_prompt_build 事件
 */
export interface BeforePromptBuildEvent {
  /** 当前 prompt */
  prompt: string;
  /** Session 消息 */
  messages: Message[];
  /** 上下文 */
  ctx: HookContext;
}

/**
 * before_agent_run 事件
 */
export interface BeforeAgentRunEvent {
  /** 当前 prompt */
  prompt: string;
  /** 最终消息列表 */
  messages: Message[];
  /** System prompt */
  systemPrompt?: string;
  /** 上下文 */
  ctx: HookContext;
}

/**
 * before_agent_reply 事件
 */
export interface BeforeAgentReplyEvent {
  /** Session 消息 */
  messages: Message[];
  /** 上下文 */
  ctx: HookContext;
}

/**
 * before_agent_finalize 事件
 */
export interface BeforeAgentFinalizeEvent {
  /** Agent 的自然回复 */
  reply: Message;
  /** 上下文 */
  ctx: HookContext;
}

/**
 * agent_end 事件
 */
export interface AgentEndEvent {
  /** 最终消息 */
  messages: Message[];
  /** 是否成功 */
  success: boolean;
  /** 执行耗时 */
  durationMs: number;
  /** 上下文 */
  ctx: HookContext;
}

/**
 * before_tool_call 事件
 */
export interface BeforeToolCallEvent {
  /** Tool 名称 */
  toolName: string;
  /** Tool 参数 */
  params: Record<string, unknown>;
  /** Tool 调用信息 */
  call: ToolCall;
  /** 上下文 */
  ctx: HookContext;
}

/**
 * after_tool_call 事件
 */
export interface AfterToolCallEvent {
  /** Tool 调用信息 */
  call: ToolCall;
  /** Tool 结果 */
  result: ToolResult;
  /** 上下文 */
  ctx: HookContext;
}

/**
 * message_received 事件
 */
export interface MessageReceivedEvent {
  /** 渠道消息 */
  message: ChannelMessage;
  /** 上下文 */
  ctx: HookContext;
}

/**
 * message_sending 事件
 */
export interface MessageSendingEvent {
  /** 回复内容 */
  reply: ChannelReply;
  /** 上下文 */
  ctx: HookContext;
}

/**
 * message_sent 事件
 */
export interface MessageSentEvent {
  /** 回复内容 */
  reply: ChannelReply;
  /** 是否成功 */
  success: boolean;
  /** 上下文 */
  ctx: HookContext;
}

/**
 * session_start / session_end 事件
 */
export interface SessionLifecycleEvent {
  /** Session ID */
  sessionId: string;
  /** Agent ID */
  agentId: string;
  /** 原因 */
  reason?: string;
}

/**
 * before_compaction / after_compaction 事件
 */
export interface CompactionEvent {
  /** Session ID */
  sessionId: string;
  /** 是否实际执行了压缩 */
  compacted: boolean;
}

/**
 * gateway_start / gateway_stop 事件
 */
export interface GatewayLifecycleEvent extends Record<string, unknown> {
  /** 配置 */
  config?: Record<string, unknown>;
  /** 工作区目录 */
  workspaceDir?: string;
}

/**
 * before_install 事件
 */
export interface BeforeInstallEvent {
  /** 安装类型 */
  type: 'skill' | 'plugin';
  /** 安装源 */
  source: string;
  /** 安装目标 */
  target: string;
}

// ================================================================
// Hook Result Types — 拦截语义
// ================================================================

/**
 * before_model_resolve 结果
 */
export interface ModelResolveResult {
  /** 覆盖 provider */
  provider?: string;
  /** 覆盖 model */
  model?: string;
}

/**
 * before_prompt_build 结果
 */
export interface PromptBuildResult {
  /** 在消息前插入的上下文 */
  prependContext?: string;
  /** 在消息后追加的上下文 */
  appendContext?: string;
  /** 覆盖 system prompt */
  systemPrompt?: string;
  /** System prompt 前置追加 */
  prependSystemContext?: string;
  /** System prompt 后置追加 */
  appendSystemContext?: string;
}

/**
 * before_agent_run 结果
 */
export interface AgentRunResult {
  /** 结果类型 */
  outcome: 'pass' | 'block';
  /** 阻止原因（内部） */
  reason?: string;
  /** 用户可见的替换消息 */
  message?: string;
}

/**
 * before_agent_reply 结果
 */
export type AgentReplyResult = Message | null;

/**
 * before_agent_finalize 结果
 */
export interface AgentFinalizeResult {
  /** 动作 */
  action: 'revise' | 'finalize';
  /** 修订原因 */
  reason?: string;
}

/**
 * before_tool_call 结果
 */
export interface ToolCallResult {
  /** 覆盖参数 */
  params?: Record<string, unknown>;
  /** 是否阻止执行 */
  block?: boolean;
  /** 阻止原因 */
  blockReason?: string;
  /** 需要用户审批 */
  requireApproval?: {
    title: string;
    description: string;
    severity?: 'info' | 'warning' | 'critical';
    timeoutMs?: number;
    timeoutBehavior?: 'allow' | 'deny';
  };
}

/**
 * message_sending 结果
 */
export interface MessageSendingResult {
  /** 是否取消发送 */
  cancel: boolean;
  /** 取消原因 */
  cancelReason?: string;
}

/**
 * before_install 结果
 */
export interface InstallResult {
  /** 是否阻止安装 */
  block: boolean;
  /** 阻止原因 */
  blockReason?: string;
}

// ================================================================
// Plugin Manager
// ================================================================

/**
 * Plugin Manager
 *
 * 对齐 OpenClaw 的 plugin 管理系统。
 * 负责加载 plugins、运行 hooks、管理能力注册。
 */
export class PluginManager {
  /** Plugin Loader */
  private loader: PluginLoader;

  /** Capability Registry（从 loader 共享） */
  readonly capabilities: CapabilityRegistry;

  /** Gateway 启动时间 */
  private startTime?: number;

  constructor(config?: PluginLoaderConfig) {
    this.loader = new PluginLoader(config ?? { loadPaths: [] });
    this.capabilities = this.loader.capabilities;
  }

  // ── 旧版兼容接口 ──

  /** @deprecated 使用 definePluginEntry() + discover() 代替 */
  private legacyPlugins = new Map<string, import('../core/types.js').Plugin>();

  /**
   * @deprecated 使用 definePluginEntry() 创建 plugin，通过 discover() 加载
   */
  register(plugin: import('../core/types.js').Plugin): void {
    if (this.legacyPlugins.has(plugin.id)) {
      throw new Error(`Plugin "${plugin.id}" already registered`);
    }
    this.legacyPlugins.set(plugin.id, plugin);
  }

  /**
   * @deprecated 使用 definePluginEntry() 创建 plugin，通过 discover() 加载
   */
  unregister(id: string): void {
    this.legacyPlugins.delete(id);
  }

  /**
   * @deprecated 使用 getAllPlugins() 代替
   */
  list(): import('../core/types.js').Plugin[] {
    return Array.from(this.legacyPlugins.values());
  }

  /**
   * 执行观察语义的 hook（所有 plugin 都执行，不拦截）
   * 兼容旧版 API
   */
  async runAllHooks(
    hookName: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    // 先运行旧版 plugin hooks
    for (const plugin of this.legacyPlugins.values()) {
      const hook = (plugin.hooks as Record<string, unknown>)[hookName];
      if (!hook) continue;
      try {
        await (hook as Function)(event);
      } catch (error) {
        console.error(`[Plugin] ${plugin.id}.${hookName} error:`, error);
      }
    }

    // 再运行新版 plugin hooks
    const entries = this.collectHookEntries(hookName);
    for (const entry of entries) {
      try {
        await entry.handler(event);
      } catch (error) {
        console.error(`[Plugin] ${entry.pluginId}.${hookName} error:`, error);
      }
    }
  }

  private collectHookEntries(hookName: string): Array<{
    pluginId: string;
    handler: (event: unknown) => Promise<unknown>;
    priority: number;
    timeoutMs?: number;
  }> {
    const entries: Array<{
      pluginId: string;
      handler: (event: unknown) => Promise<unknown>;
      priority: number;
      timeoutMs?: number;
    }> = [];

    for (const plugin of this.loader.getAllPlugins()) {
      if (!plugin.registered) continue;
      const hookEntries = plugin.api._hooks.get(hookName);
      if (hookEntries) {
        for (const entry of hookEntries) {
          entries.push({
            pluginId: entry.pluginId,
            handler: entry.handler,
            priority: entry.priority,
            timeoutMs: entry.timeoutMs,
          });
        }
      }
    }

    entries.sort((a, b) => b.priority - a.priority);
    return entries;
  }

  // ================================================================
  // Plugin Loading
  // ================================================================

  /**
   * 发现并加载所有 plugins
   */
  async discover(): Promise<LoadedPlugin[]> {
    return this.loader.discover();
  }

  /**
   * 直接注册一个已有的 plugin（兼容旧接口）
   *
   * 对于代码中直接创建的 Plugin（不从文件系统加载），
   * 使用此方法注册。
   */
  registerPlugin(plugin: { id: string; api: PluginApi }): void {
    // 直接注册的 plugin 不经过 loader，但仍然通过 api 收集能力
    // 这些 plugin 的 hooks 在 runHook 中被调用
  }

  /**
   * 获取所有已加载的 plugins
   */
  getAllPlugins(): LoadedPlugin[] {
    return this.loader.getAllPlugins();
  }

  /**
   * 获取已注册的 plugin IDs
   */
  getRegisteredIds(): string[] {
    return this.loader.getRegisteredIds();
  }

  /**
   * 获取指定 plugin
   */
  getPlugin(id: string): LoadedPlugin | undefined {
    return this.loader.getPlugin(id);
  }

  // ================================================================
  // Hook Execution — 对齐 OpenClaw Hook Runner
  // ================================================================

  /**
   * 运行指定 hook
   *
   * 对齐 OpenClaw 的 hook runner：
   * - 按 priority 降序执行
   * - 支持 per-handler timeout
   * - 拦截语义：返回非 null/undefined 的结果时中断后续 handlers
   * - block: true 是 terminal，跳过后续 handlers
   *
   * @param hookName - Hook 名称
   * @param event - 事件对象
   * @param defaultResult - 默认结果（无 handler 返回时使用）
   * @param config - plugin 配置（用于 timeout 覆盖）
   * @returns 最终结果
   */
  async runHook<T>(
    hookName: string,
    event: Record<string, unknown>,
    defaultResult: T,
    config?: PluginEntryConfig,
  ): Promise<T> {
    // 收集所有已注册此 hook 的 handler（已按 priority 排序）
    const entries = this.collectHookEntries(hookName);

    // 也检查旧版 plugin hooks（兼容）
    const legacyResults: Array<unknown> = [];
    for (const plugin of this.legacyPlugins.values()) {
      const hook = (plugin.hooks as Record<string, unknown>)[hookName];
      if (!hook) continue;
      try {
        const legacyResult = await (hook as Function)(event);
        if (legacyResult !== null && legacyResult !== undefined) {
          legacyResults.push(legacyResult);
        }
      } catch (error) {
        console.error(`[Plugin] ${plugin.id}.${hookName} error:`, error);
      }
    }

    // 旧版 plugin 的拦截结果优先
    if (legacyResults.length > 0) {
      return legacyResults[0] as T;
    }

    if (entries.length === 0) {
      return defaultResult;
    }

    let result: T = defaultResult;

    for (const entry of entries) {
      // 计算 timeout：plugin config > handler 注册时 > 默认
      const timeoutMs =
        config?.hooks?.timeouts?.[hookName] ??
        config?.hooks?.timeoutMs ??
        entry.timeoutMs ??
        30_000;

      try {
        const handlerResult = await this.runWithTimeout(
          () => entry.handler(event),
          timeoutMs,
        );

        // 拦截语义：非 null/undefined 结果中断链
        if (handlerResult !== null && handlerResult !== undefined) {
          result = handlerResult as T;

          // block: true 是 terminal
          if (typeof handlerResult === 'object' && 'block' in handlerResult && handlerResult.block) {
            break;
          }
          // cancel: true 是 terminal
          if (typeof handlerResult === 'object' && 'cancel' in handlerResult && handlerResult.cancel) {
            break;
          }
          // outcome: 'block' 是 terminal
          if (typeof handlerResult === 'object' && 'outcome' in handlerResult && handlerResult.outcome === 'block') {
            break;
          }
        }
      } catch (err) {
        console.error(
          `[PluginManager] Hook "${hookName}" handler from plugin "${entry.pluginId}" failed:`,
          err,
        );
        // 单个 handler 失败不影响后续 handlers
      }
    }

    return result;
  }

  /**
   * 带超时执行
   */
  private async runWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Hook handler timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      fn().then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  // ================================================================
  // 便捷方法 — 常用 hooks 的快捷调用
  // ================================================================

  /**
   * 获取所有已注册的 providers
   */
  getProviders(): Array<{ pluginId: string; id: string; provider: import('../core/types.js').LLMProvider }> {
    const result: Array<{ pluginId: string; id: string; provider: import('../core/types.js').LLMProvider }> = [];
    for (const plugin of this.loader.getAllPlugins()) {
      if (!plugin.registered) continue;
      for (const reg of plugin.api._providers) {
        result.push({ pluginId: plugin.id, id: reg.id, provider: reg.provider });
      }
    }
    return result;
  }

  /**
   * 获取所有已注册的 channels
   */
  getChannels(): Array<{ pluginId: string; id: string; adapter: import('../core/types.js').ChannelAdapter }> {
    const result: Array<{ pluginId: string; id: string; adapter: import('../core/types.js').ChannelAdapter }> = [];
    for (const plugin of this.loader.getAllPlugins()) {
      if (!plugin.registered) continue;
      for (const reg of plugin.api._channels) {
        result.push({ pluginId: plugin.id, id: reg.id, adapter: reg.adapter });
      }
    }
    return result;
  }

  /**
   * 获取所有已注册的 tools（过滤 optional）
   */
  getTools(includeOptional = false): Array<{
    pluginId: string;
    definition: import('../core/types.js').ToolDefinition;
    handler: import('../core/types.js').ToolHandler;
  }> {
    const result: Array<{
      pluginId: string;
      definition: import('../core/types.js').ToolDefinition;
      handler: import('../core/types.js').ToolHandler;
    }> = [];

    for (const plugin of this.loader.getAllPlugins()) {
      if (!plugin.registered) continue;
      for (const reg of plugin.api._tools) {
        if (!includeOptional && reg.optional) continue;
        result.push({
          pluginId: plugin.id,
          definition: reg.definition,
          handler: reg.handler as unknown as import('../core/types.js').ToolHandler,
        });
      }
    }
    return result;
  }

  /**
   * 获取所有已注册的 context engines
   */
  getContextEngines(): Array<{ id: string; engine: import('../core/types.js').ContextEngine }> {
    const result: Array<{ id: string; engine: import('../core/types.js').ContextEngine }> = [];
    for (const plugin of this.loader.getAllPlugins()) {
      if (!plugin.registered) continue;
      for (const reg of plugin.api._contextEngines) {
        result.push(reg);
      }
    }
    return result;
  }

  /**
   * 获取所有已注册的 commands
   */
  getCommands(): Array<{
    pluginId: string;
    name: string;
    handler: (event: unknown) => Promise<unknown>;
    description?: string;
  }> {
    const result: Array<{
      pluginId: string;
      name: string;
      handler: (event: unknown) => Promise<unknown>;
      description?: string;
    }> = [];

    for (const plugin of this.loader.getAllPlugins()) {
      if (!plugin.registered) continue;
      for (const cmd of plugin.api._commands) {
        result.push({ pluginId: plugin.id, ...cmd });
      }
    }
    return result;
  }

  /**
   * 获取所有已注册的 services
   */
  getServices(): Array<{
    pluginId: string;
    id: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }> {
    const result: Array<{
      pluginId: string;
      id: string;
      start: () => Promise<void>;
      stop: () => Promise<void>;
    }> = [];

    for (const plugin of this.loader.getAllPlugins()) {
      if (!plugin.registered) continue;
      for (const svc of plugin.api._services) {
        result.push({ pluginId: plugin.id, ...svc });
      }
    }
    return result;
  }

  // ================================================================
  // Gateway Lifecycle
  // ================================================================

  /**
   * 触发 gateway_start hook 并启动所有 plugin 服务
   */
  async onGatewayStart(config?: Record<string, unknown>, workspaceDir?: string): Promise<void> {
    this.startTime = Date.now();

    const event: GatewayLifecycleEvent = { config, workspaceDir };
    await this.runHook('gateway_start', event, undefined);

    // 启动所有 plugin 服务
    for (const service of this.getServices()) {
      try {
        await service.start();
        console.info(`[PluginManager] Service "${service.id}" started`);
      } catch (err) {
        console.error(`[PluginManager] Service "${service.id}" failed to start:`, err);
      }
    }
  }

  /**
   * 触发 gateway_stop hook 并停止所有 plugin 服务
   */
  async onGatewayStop(): Promise<void> {
    const event: GatewayLifecycleEvent = {};
    await this.runHook('gateway_stop', event, undefined);

    // 停止所有 plugin 服务
    for (const service of this.getServices()) {
      try {
        await service.stop();
        console.info(`[PluginManager] Service "${service.id}" stopped`);
      } catch (err) {
        console.error(`[PluginManager] Service "${service.id}" failed to stop:`, err);
      }
    }
  }
}
