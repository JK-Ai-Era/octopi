/**
 * Plugin Loader — Plugin 发现和加载
 *
 * 对齐 OpenClaw 的 plugin loading pipeline：
 * 1. Discovery — 从配置路径发现候选 plugins
 * 2. Validation — 验证 manifest、检查 enable/disable 状态
 * 3. Loading — 进程内加载 plugin 代码
 * 4. Registration — 调用 register() 注册能力
 *
 * 参考: https://docs.openclaw.ai/plugins/architecture#architecture-overview
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { PluginManifest } from './manifest.js';
import { validateManifest } from './manifest.js';
import type { OctopiPluginDefinition } from './entry.js';
import type { PluginApi } from './api.js';
import { PluginApi as PluginApiClass } from './api.js';
import { CapabilityRegistry, registerManifestCapabilities } from './capability.js';

/**
 * 加载后的 Plugin 实例
 */
export interface LoadedPlugin {
  /** Plugin ID */
  id: string;
  /** Plugin Manifest */
  manifest: PluginManifest;
  /** Plugin 定义（包含 register 回调） */
  definition: OctopiPluginDefinition;
  /** Plugin API 实例 */
  api: PluginApi;
  /** Plugin 源路径 */
  source: string;
  /** Plugin root 目录 */
  rootDir: string;
  /** 是否已执行 register() */
  registered: boolean;
}

/**
 * Plugin Loader 配置
 */
export interface PluginLoaderConfig {
  /** Plugin 搜索路径列表 */
  loadPaths: string[];

  /** 允许的 plugin IDs（白名单，空 = 全部允许） */
  allowList?: string[];

  /** 禁用的 plugin IDs */
  blockList?: string[];

  /** Plugin 配置 entries */
  pluginEntries?: Record<string, PluginEntryConfig>;
}

/**
 * Plugin Entry 配置（来自 openclaw.json）
 */
export interface PluginEntryConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** Plugin 配置 */
  config?: Record<string, unknown>;
  /** Hook 配置 */
  hooks?: {
    /** 全局 hook 超时 */
    timeoutMs?: number;
    /** 按 hook 名称的超时 */
    timeouts?: Record<string, number>;
    /** 超时后是否中断 hook 链（默认 false：跳过并继续） */
    abortOnTimeout?: Record<string, boolean>;
    /** 是否允许 conversation access */
    allowConversationAccess?: boolean;
    /** 是否允许 prompt injection */
    allowPromptInjection?: boolean;
  };
}

/**
 * Plugin Loader
 *
 * 负责从文件系统发现和加载 plugins。
 */
export class PluginLoader {
  /** 已加载的 plugins */
  private plugins = new Map<string, LoadedPlugin>();

  /** Capability Registry */
  readonly capabilities = new CapabilityRegistry();

  /** 配置 */
  private config: PluginLoaderConfig;

  constructor(config: PluginLoaderConfig) {
    this.config = config;
  }

  /**
   * 发现并加载所有 plugins
   *
   * 扫描所有配置路径，查找包含 octopi.plugin.json 的目录。
   *
   * @returns 加载的 plugin 列表
   */
  async discover(): Promise<LoadedPlugin[]> {
    const discovered: LoadedPlugin[] = [];

    for (const loadPath of this.config.loadPaths) {
      try {
        const plugins = await this.scanDirectory(loadPath);
        discovered.push(...plugins);
      } catch (err) {
        console.warn(`[PluginLoader] Failed to scan "${loadPath}":`, err);
      }
    }

    // 过滤：allowlist / blocklist / enabled
    const filtered = this.filterPlugins(discovered);

    // 执行 register()
    for (const plugin of filtered) {
      await this.registerPlugin(plugin);
    }

    return filtered;
  }

  /**
   * 扫描单个目录，发现 plugins
   */
  private async scanDirectory(dirPath: string): Promise<LoadedPlugin[]> {
    const plugins: LoadedPlugin[] = [];

    if (!existsSync(dirPath)) {
      return plugins;
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginDir = path.join(dirPath, entry.name);
      const manifestPath = path.join(pluginDir, 'octopi.plugin.json');

      // 也检查 OpenClaw 格式的 manifest
      const openclawManifestPath = path.join(pluginDir, 'openclaw.plugin.json');

      let manifestFile: string | null = null;
      if (existsSync(manifestPath)) {
        manifestFile = manifestPath;
      } else if (existsSync(openclawManifestPath)) {
        manifestFile = openclawManifestPath;
      }

      if (!manifestFile) continue;

      try {
        const plugin = await this.loadPluginFromDir(pluginDir, manifestFile);
        if (plugin) {
          plugins.push(plugin);
        }
      } catch (err) {
        console.warn(`[PluginLoader] Failed to load plugin from "${pluginDir}":`, err);
      }
    }

    return plugins;
  }

  /**
   * 从目录加载单个 plugin
   */
  private async loadPluginFromDir(
    pluginDir: string,
    manifestPath: string,
  ): Promise<LoadedPlugin | null> {
    // 1. 读取和验证 manifest
    const manifestJson = await fs.readFile(manifestPath, 'utf-8');
    let manifest: PluginManifest;
    try {
      manifest = validateManifest(JSON.parse(manifestJson));
    } catch (err) {
      console.warn(`[PluginLoader] Invalid manifest at "${manifestPath}":`, err);
      return null;
    }

    // 2. 查找入口文件
    const entryPoint = await this.resolveEntryPoint(pluginDir);
    if (!entryPoint) {
      console.warn(`[PluginLoader] No entry point found in "${pluginDir}"`);
      return null;
    }

    // 3. 加载 plugin 模块
    let definition: OctopiPluginDefinition;
    try {
      const module = await import(entryPoint);
      definition = module.default ?? module;
      if (!definition?.id || !definition?.register) {
        console.warn(`[PluginLoader] Invalid plugin definition in "${entryPoint}": missing id or register`);
        return null;
      }
    } catch (err) {
      console.warn(`[PluginLoader] Failed to import "${entryPoint}":`, err);
      return null;
    }

    // 4. 创建 PluginApi
    const entryConfig = this.config.pluginEntries?.[manifest.id];
    const api = new PluginApiClass({
      id: manifest.id,
      name: definition.name ?? manifest.name ?? manifest.id,
      version: definition.version ?? manifest.version,
      description: definition.description ?? manifest.description,
      source: entryPoint,
      rootDir: pluginDir,
      pluginConfig: entryConfig?.config,
    });

    // 5. 注册 manifest 中声明的能力
    try {
      registerManifestCapabilities(manifest, this.capabilities);
    } catch (err) {
      console.warn(`[PluginLoader] Capability registration failed for "${manifest.id}":`, err);
      return null;
    }

    const plugin: LoadedPlugin = {
      id: manifest.id,
      manifest,
      definition,
      api,
      source: entryPoint,
      rootDir: pluginDir,
      registered: false,
    };

    this.plugins.set(manifest.id, plugin);
    return plugin;
  }

  /**
   * 解析 plugin 入口文件
   *
   * 查找顺序：
   * 1. package.json 中的 main / exports
   * 2. index.ts / index.js
   * 3. src/index.ts / src/index.js
   */
  private async resolveEntryPoint(pluginDir: string): Promise<string | null> {
    // 检查 package.json
    const pkgPath = path.join(pluginDir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
        // openclaw 字段中的 extensions
        if (pkg.openclaw?.extensions?.[0]) {
          const ext = path.resolve(pluginDir, pkg.openclaw.extensions[0]);
          if (existsSync(ext)) return ext;
        }
        // main 字段
        if (pkg.main) {
          const main = path.resolve(pluginDir, pkg.main);
          if (existsSync(main)) return main;
        }
      } catch {
        // ignore
      }
    }

    // 尝试常见入口文件
    const candidates = [
      'index.ts', 'index.js', 'index.mjs',
      'src/index.ts', 'src/index.js', 'src/index.mjs',
      'dist/index.js', 'dist/index.mjs',
    ];

    for (const candidate of candidates) {
      const fullPath = path.join(pluginDir, candidate);
      if (existsSync(fullPath)) return fullPath;
    }

    return null;
  }

  /**
   * 过滤 plugins（allowlist / blocklist / enabled）
   */
  private filterPlugins(plugins: LoadedPlugin[]): LoadedPlugin[] {
    return plugins.filter((plugin) => {
      // Blocklist
      if (this.config.blockList?.includes(plugin.id)) {
        console.info(`[PluginLoader] Plugin "${plugin.id}" is blocklisted, skipping`);
        return false;
      }

      // Allowlist
      if (this.config.allowList && this.config.allowList.length > 0) {
        if (!this.config.allowList.includes(plugin.id)) {
          console.info(`[PluginLoader] Plugin "${plugin.id}" not in allowlist, skipping`);
          return false;
        }
      }

      // Enabled check
      const entryConfig = this.config.pluginEntries?.[plugin.id];
      if (entryConfig?.enabled === false) {
        console.info(`[PluginLoader] Plugin "${plugin.id}" is disabled, skipping`);
        return false;
      }

      // Manifest enabledByDefault check
      if (plugin.manifest.enabledByDefault !== true && !entryConfig) {
        // 如果没有显式配置且 manifest 没有设置 enabledByDefault，则跳过
        // 除非有其他触发条件
        const hasActivation = plugin.manifest.activation &&
          (plugin.manifest.activation.onProviders?.length ||
            plugin.manifest.activation.onChannels?.length ||
            plugin.manifest.activation.onCommands?.length);

        if (!hasActivation && !plugin.manifest.enabledByDefault) {
          console.info(`[PluginLoader] Plugin "${plugin.id}" not enabled by default and no config, skipping`);
          return false;
        }
      }

      // 依赖检查
      if (plugin.manifest.requiresPlugins) {
        for (const dep of plugin.manifest.requiresPlugins) {
          if (!plugins.some((p) => p.id === dep)) {
            console.warn(`[PluginLoader] Plugin "${plugin.id}" requires "${dep}" which is not loaded`);
            // 不阻塞，只警告（对齐 OpenClaw 行为）
          }
        }
      }

      return true;
    });
  }

  /**
   * 执行 plugin 的 register()
   */
  private async registerPlugin(plugin: LoadedPlugin): Promise<void> {
    if (plugin.registered) return;

    try {
      await plugin.definition.register(plugin.api);
      plugin.registered = true;
      console.info(`[PluginLoader] Plugin "${plugin.id}" registered successfully`);
    } catch (err) {
      console.error(`[PluginLoader] Plugin "${plugin.id}" register() failed:`, err);
    }
  }

  /**
   * 获取已加载的 plugin
   */
  getPlugin(id: string): LoadedPlugin | undefined {
    return this.plugins.get(id);
  }

  /**
   * 获取所有已加载的 plugins
   */
  getAllPlugins(): LoadedPlugin[] {
    return [...this.plugins.values()];
  }

  /**
   * 获取所有已注册的 plugin IDs
   */
  getRegisteredIds(): string[] {
    return [...this.plugins.values()].filter((p) => p.registered).map((p) => p.id);
  }
}
