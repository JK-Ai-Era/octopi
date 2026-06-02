/**
 * Plugin API — 对齐 OpenClaw 的 OpenClawPluginApi
 *
 * 这是 plugin register() 回调中接收的 api 对象。
 * Plugin 通过它注册各种能力（provider、channel、tool、hook 等）。
 *
 * 参考: https://docs.openclaw.ai/plugins/sdk-overview#registration-api
 */

import type { PluginManifest } from './manifest.js';
import type {
  LLMProvider,
  ChannelAdapter,
  RegisteredTool,
  ToolDefinition,
  ToolHandler,
  ContextEngine,
} from '../core/types.js';

/**
 * Hook 注册选项
 */
export interface HookRegistrationOptions {
  /** 优先级（数字越大越先执行，默认 0） */
  priority?: number;

  /** 单个 handler 超时毫秒数 */
  timeoutMs?: number;
}

/**
 * Tool 注册选项
 */
export interface ToolRegistrationOptions {
  /** 是否为可选工具（需要用户显式启用） */
  optional?: boolean;
}

/**
 * Provider 注册定义
 */
export interface ProviderRegistration {
  /** Provider ID */
  id: string;

  /** Provider 实例 */
  provider: LLMProvider;
}

/**
 * Channel 注册定义
 */
export interface ChannelRegistration {
  /** Channel ID */
  id: string;

  /** Channel Adapter 实例 */
  adapter: ChannelAdapter;
}

/**
 * Hook handler 类型
 */
export type HookHandler<TEvent = unknown, TResult = void> = (
  event: TEvent,
) => Promise<TResult | undefined | void>;

/**
 * 有序 hook entry
 */
export interface OrderedHookEntry {
  /** Plugin ID */
  pluginId: string;
  /** Hook 名称 */
  hookName: string;
  /** Handler 函数 */
  handler: HookHandler;
  /** 优先级 */
  priority: number;
  /** 超时 */
  timeoutMs?: number;
}

/**
 * Plugin Logger
 */
export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Plugin API
 *
 * 对齐 OpenClaw 的 OpenClawPluginApi。
 * Plugin 在 register() 回调中使用此对象注册能力。
 */
export class PluginApi {
  /** Plugin ID */
  readonly id: string;

  /** Plugin 显示名称 */
  readonly name: string;

  /** Plugin 版本 */
  readonly version?: string;

  /** Plugin 描述 */
  readonly description?: string;

  /** Plugin 源路径 */
  readonly source: string;

  /** Plugin root 目录 */
  readonly rootDir?: string;

  /** Plugin 配置 */
  readonly pluginConfig: Record<string, unknown>;

  /** Plugin Logger */
  readonly logger: PluginLogger;

  // ── 内部存储（PluginManager 读取） ──

  /** 已注册的 providers */
  readonly _providers: ProviderRegistration[] = [];

  /** 已注册的 channels */
  readonly _channels: ChannelRegistration[] = [];

  /** 已注册的 tools */
  readonly _tools: Array<{ definition: ToolDefinition; handler: HookHandler; optional: boolean }> = [];

  /** 已注册的 context engines */
  readonly _contextEngines: Array<{ id: string; engine: ContextEngine }> = [];

  /** 已注册的 hooks */
  readonly _hooks: Map<string, OrderedHookEntry[]> = new Map();

  /** 已注册的 commands */
  readonly _commands: Array<{ name: string; handler: HookHandler; description?: string }> = [];

  /** 已注册的服务 */
  readonly _services: Array<{ id: string; start: () => Promise<void>; stop: () => Promise<void> }> = [];

  constructor(opts: {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source: string;
    rootDir?: string;
    pluginConfig?: Record<string, unknown>;
  }) {
    this.id = opts.id;
    this.name = opts.name;
    this.version = opts.version;
    this.description = opts.description;
    this.source = opts.source;
    this.rootDir = opts.rootDir;
    this.pluginConfig = opts.pluginConfig ?? {};

    const prefix = `[plugin:${opts.id}]`;
    this.logger = {
      debug: (msg, ...args) => console.debug(`${prefix} ${msg}`, ...args),
      info: (msg, ...args) => console.info(`${prefix} ${msg}`, ...args),
      warn: (msg, ...args) => console.warn(`${prefix} ${msg}`, ...args),
      error: (msg, ...args) => console.error(`${prefix} ${msg}`, ...args),
    };
  }

  // ================================================================
  // Capability Registration — 对齐 OpenClaw
  // ================================================================

  /**
   * 注册 LLM Provider
   *
   * @param registration - Provider 注册定义
   */
  registerProvider(registration: ProviderRegistration): void {
    this._providers.push(registration);
    this.logger.info(`Registered provider: ${registration.id}`);
  }

  /**
   * 注册 Channel Adapter
   *
   * @param registration - Channel 注册定义
   */
  registerChannel(registration: ChannelRegistration): void {
    this._channels.push(registration);
    this.logger.info(`Registered channel: ${registration.id}`);
  }

  /**
   * 注册 Agent Tool
   *
   * 对齐 OpenClaw 的 api.registerTool()。
   * Tool 名称不能与核心 tool 冲突。
   *
   * @param tool - Tool 定义（包含 name、description、parameters）
   * @param handler - Tool 处理函数
   * @param opts - 注册选项
   */
  registerTool(
    tool: ToolDefinition,
    handler: ToolHandler,
    opts?: ToolRegistrationOptions,
  ): void {
    this._tools.push({
      definition: tool,
      handler: handler as HookHandler,
      optional: opts?.optional ?? false,
    });
    this.logger.info(`Registered tool: ${tool.name}${opts?.optional ? ' (optional)' : ''}`);
  }

  /**
   * 注册 Context Engine
   *
   * Context Engine 是 exclusive slot —— 同一时刻只有一个 active。
   *
   * @param id - Engine ID
   * @param engine - Context Engine 实例
   */
  registerContextEngine(id: string, engine: ContextEngine): void {
    this._contextEngines.push({ id, engine });
    this.logger.info(`Registered context engine: ${id}`);
  }

  /**
   * 注册 Hook
   *
   * 对齐 OpenClaw 的 api.on()。
   * Hook handler 按 priority 降序执行，同 priority 按注册顺序。
   *
   * @param hookName - Hook 名称
   * @param handler - Hook handler
   * @param opts - 选项（priority、timeoutMs）
   */
  on<TEvent = unknown, TResult = void>(
    hookName: string,
    handler: (event: TEvent) => Promise<TResult | undefined | void>,
    opts?: HookRegistrationOptions,
  ): void {
    if (!this._hooks.has(hookName)) {
      this._hooks.set(hookName, []);
    }

    const entries = this._hooks.get(hookName)!;
    entries.push({
      pluginId: this.id,
      hookName,
      handler: handler as HookHandler,
      priority: opts?.priority ?? 0,
      timeoutMs: opts?.timeoutMs,
    });

    // 保持按 priority 降序排列
    entries.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 注册 Command
   *
   * Command 绕过 LLM，直接执行。
   *
   * @param def - Command 定义
   */
  registerCommand(def: {
    name: string;
    handler: HookHandler;
    description?: string;
  }): void {
    this._commands.push(def);
    this.logger.info(`Registered command: ${def.name}`);
  }

  /**
   * 注册后台服务
   *
   * 服务在 Gateway 启动时 start，关闭时 stop。
   *
   * @param service - 服务定义
   */
  registerService(service: {
    id: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }): void {
    this._services.push(service);
    this.logger.info(`Registered service: ${service.id}`);
  }

  // ================================================================
  // Extended Registration — 对齐 OpenClaw 更多能力注册
  // ================================================================

  /** 已注册的 web search providers */
  readonly _webSearchProviders: Array<{ id: string; provider: unknown }> = [];

  /** 已注册的 media understanding providers */
  readonly _mediaUnderstandingProviders: Array<{ id: string; provider: unknown }> = [];

  /** 已注册的 image generation providers */
  readonly _imageGenerationProviders: Array<{ id: string; provider: unknown }> = [];

  /** 已注册的 music generation providers */
  readonly _musicGenerationProviders: Array<{ id: string; provider: unknown }> = [];

  /** 已注册的 video generation providers */
  readonly _videoGenerationProviders: Array<{ id: string; provider: unknown }> = [];

  /** 已注册的 speech providers */
  readonly _speechProviders: Array<{ id: string; provider: unknown }> = [];

  /** 已注册的 model catalog providers */
  readonly _modelCatalogProviders: Array<{ provider: string; kinds: string[]; liveCatalog: unknown }> = [];

  /** 已注册的 memory embedding providers */
  readonly _memoryEmbeddingProviders: Array<{ id: string; provider: unknown }> = [];

  /**
   * 注册 Web Search Provider
   */
  registerWebSearchProvider(provider: unknown): void {
    const id = (provider as any)?.id ?? 'unknown';
    this._webSearchProviders.push({ id, provider });
    this.logger.info(`Registered web search provider: ${id}`);
  }

  /**
   * 注册 Media Understanding Provider
   */
  registerMediaUnderstandingProvider(provider: unknown): void {
    const id = (provider as any)?.id ?? 'unknown';
    this._mediaUnderstandingProviders.push({ id, provider });
    this.logger.info(`Registered media understanding provider: ${id}`);
  }

  /**
   * 注册 Image Generation Provider
   */
  registerImageGenerationProvider(provider: unknown): void {
    const id = (provider as any)?.id ?? 'unknown';
    this._imageGenerationProviders.push({ id, provider });
    this.logger.info(`Registered image generation provider: ${id}`);
  }

  /**
   * 注册 Music Generation Provider
   */
  registerMusicGenerationProvider(provider: unknown): void {
    const id = (provider as any)?.id ?? 'unknown';
    this._musicGenerationProviders.push({ id, provider });
    this.logger.info(`Registered music generation provider: ${id}`);
  }

  /**
   * 注册 Video Generation Provider
   */
  registerVideoGenerationProvider(provider: unknown): void {
    const id = (provider as any)?.id ?? 'unknown';
    this._videoGenerationProviders.push({ id, provider });
    this.logger.info(`Registered video generation provider: ${id}`);
  }

  /**
   * 注册 Speech Provider
   */
  registerSpeechProvider(provider: unknown): void {
    const id = (provider as any)?.id ?? 'unknown';
    this._speechProviders.push({ id, provider });
    this.logger.info(`Registered speech provider: ${id}`);
  }

  /**
   * 注册 Model Catalog Provider
   */
  registerModelCatalogProvider(catalog: { provider: string; kinds: string[]; liveCatalog: unknown }): void {
    this._modelCatalogProviders.push(catalog);
    this.logger.info(`Registered model catalog: ${catalog.provider} (${catalog.kinds.join(', ')})`);
  }

  /**
   * 注册 Memory Embedding Provider
   */
  registerMemoryEmbeddingProvider(provider: unknown): void {
    const id = (provider as any)?.id ?? 'unknown';
    this._memoryEmbeddingProviders.push({ id, provider });
    this.logger.info(`Registered memory embedding provider: ${id}`);
  }

  // ================================================================
  // Utility
  // ================================================================

  /**
   * 解析相对于 plugin root 的路径
   *
   * @param input - 相对路径
   * @returns 绝对路径
   */
  resolvePath(input: string): string {
    if (!this.rootDir) return input;
    const path = require('node:path');
    return path.resolve(this.rootDir, input);
  }
}
