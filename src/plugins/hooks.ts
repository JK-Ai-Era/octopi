import type { Plugin, PluginHooks, HookContext } from '../core/types.js';

/**
 * 插件管理器
 *
 * 参考 OpenClaw 的 Plugin Hook 系统：
 * - 每个生命周期阶段都可以被多个 plugin 拦截
 * - Hook 按注册顺序执行
 * - 某些 hook 有 "拦截语义"（返回非 null 表示拦截）
 */
export class PluginManager {
  private plugins = new Map<string, Plugin>();

  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin "${plugin.id}" already registered`);
    }
    this.plugins.set(plugin.id, plugin);
  }

  unregister(id: string): void {
    this.plugins.delete(id);
  }

  list(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * 执行具有拦截语义的 hook
   * 第一个返回非 null 的 plugin 胜出
   */
  async runHook<T = any>(
    hookName: keyof PluginHooks,
    ctx: HookContext & Record<string, unknown>,
    defaultValue: T,
  ): Promise<T> {
    for (const plugin of this.plugins.values()) {
      const hook = plugin.hooks[hookName];
      if (!hook) continue;

      try {
        const result = await (hook as Function)(ctx);
        if (result !== null && result !== undefined) {
          return result as T;
        }
      } catch (error) {
        console.error(`[Plugin] ${plugin.id}.${hookName} error:`, error);
      }
    }
    return defaultValue;
  }

  /**
   * 执行无拦截语义的 hook（所有 plugin 都执行）
   */
  async runAllHooks(
    hookName: keyof PluginHooks,
    ctx: HookContext & Record<string, unknown>,
  ): Promise<void> {
    for (const plugin of this.plugins.values()) {
      const hook = plugin.hooks[hookName];
      if (!hook) continue;

      try {
        await (hook as Function)(ctx);
      } catch (error) {
        console.error(`[Plugin] ${plugin.id}.${hookName} error:`, error);
      }
    }
  }
}
