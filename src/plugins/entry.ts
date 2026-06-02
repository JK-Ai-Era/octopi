/**
 * Plugin Entry — 对齐 OpenClaw 的 definePluginEntry
 *
 * definePluginEntry 是创建 plugin 的标准方式。
 * 它定义了 plugin 的 id、name、register 回调等。
 *
 * 对齐 OpenClaw 的:
 *   import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
 *
 * 参考: https://docs.openclaw.ai/plugins/building-plugins
 */

import type { PluginApi } from './api.js';

/**
 * Plugin 定义
 *
 * 这是 plugin 的完整定义。每个 plugin 必须导出一个 default export，
 * 使用 definePluginEntry() 创建。
 *
 * @example
 * ```ts
 * export default definePluginEntry({
 *   id: 'my-plugin',
 *   name: 'My Plugin',
 *   description: 'Adds custom capabilities',
 *   register(api) {
 *     api.on('before_tool_call', async (event) => {
 *       // hook logic
 *     });
 *
 *     api.registerTool(
 *       { name: 'my_tool', description: '...', parameters: {} },
 *       async (args, ctx) => { return 'result'; },
 *     );
 *   },
 * });
 * ```
 */
export interface OctopiPluginDefinition {
  /** Plugin 唯一 ID */
  id: string;

  /** Plugin 显示名称 */
  name: string;

  /** Plugin 描述 */
  description?: string;

  /** Plugin 版本 */
  version?: string;

  /**
   * 注册回调
   *
   * 框架在加载 plugin 时调用此方法，传入 PluginApi 对象。
   * Plugin 通过 api 对象注册各种能力。
   *
   * @param api - Plugin API 对象
   */
  register(api: PluginApi): void | Promise<void>;
}

/**
 * 定义一个 Plugin Entry
 *
 * 这是创建 plugin 的标准方式，对齐 OpenClaw 的 definePluginEntry。
 *
 * @param definition - Plugin 定义
 * @returns Plugin 定义对象
 *
 * @example
 * ```ts
 * // index.ts
 * import { definePluginEntry } from 'octopi/plugin-sdk/plugin-entry';
 *
 * export default definePluginEntry({
 *   id: 'tool-preflight',
 *   name: 'Tool Preflight',
 *   register(api) {
 *     api.on('before_tool_call', async (event) => {
 *       if (event.toolName !== 'web_search') return;
 *       return { requireApproval: { title: 'Run web search' } };
 *     }, { priority: 50 });
 *   },
 * });
 * ```
 */
export function definePluginEntry(definition: OctopiPluginDefinition): OctopiPluginDefinition {
  // 验证必填字段
  if (!definition.id || typeof definition.id !== 'string') {
    throw new Error('definePluginEntry: "id" is required and must be a string');
  }
  if (!definition.name || typeof definition.name !== 'string') {
    throw new Error('definePluginEntry: "name" is required and must be a string');
  }
  if (typeof definition.register !== 'function') {
    throw new Error(`definePluginEntry: "register" is required and must be a function (plugin: ${definition.id})`);
  }

  return definition;
}

/**
 * Channel Plugin 定义
 *
 * 用于 channel 类型的 plugin。
 * 对齐 OpenClaw 的 defineChannelPluginEntry。
 */
export interface OctopiChannelPluginDefinition extends OctopiPluginDefinition {
  /** Channel ID */
  channelId: string;
}

/**
 * 定义一个 Channel Plugin Entry
 *
 * 对齐 OpenClaw 的 defineChannelPluginEntry。
 *
 * @param definition - Channel Plugin 定义
 * @returns Plugin 定义对象
 */
export function defineChannelPluginEntry(
  definition: OctopiChannelPluginDefinition,
): OctopiChannelPluginDefinition {
  if (!definition.channelId) {
    throw new Error(`defineChannelPluginEntry: "channelId" is required (plugin: ${definition.id})`);
  }

  // 基础验证
  definePluginEntry(definition as OctopiPluginDefinition);

  return definition;
}
