/** Plugin author contract. Host loading and mounting live under ./harness/. */

export { definePlugin } from './entry.js';
export type { OctopiPluginDefinition } from './entry.js';
export { PluginApi } from './api.js';
export type {
  PluginLogger,
  PluginCommandRegistration,
  PluginCommandContext,
  PluginHookMap,
  HookHandler,
  HookRegistrationOptions,
  ToolRegistrationOptions,
  PluginProviderFactory,
  PluginProviderFactoryContext,
  PluginProviderModelEntry,
  PluginProviderRegistration,
  PluginChannelFactory,
  PluginChannelFactoryContext,
  PluginChannelRegistration,
  PluginChannelAdapterLike,
  ContributionInstanceKind,
} from './api.js';
export {
  PLUGIN_API_VERSION,
  PLUGIN_HOOK_NAMES,
  validateManifest,
  parseManifest,
  validatePluginConfig,
} from './manifest.js';
export type {
  PluginManifest,
  PluginContributions,
  PluginCommandContribution,
  PluginHookName,
  PluginSessionOpName,
  JsonSchema,
} from './manifest.js';
