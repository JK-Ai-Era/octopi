/** Plugin entry contract. Installation metadata lives in octopi.plugin.json. */

import type { PluginApi } from './api.js';

export interface OctopiPluginDefinition {
  /** Must match the manifest identity. */
  id: string;
  /** Declaration-only registration; external resources start at a host lifecycle point. */
  register(api: PluginApi): void | Promise<void>;
}

/**
 * Define a v1 plugin entry without duplicating its manifest.
 *
 * @param definition - Entry identity and registration function
 * @returns The validated definition
 */
export function definePlugin(definition: OctopiPluginDefinition): OctopiPluginDefinition {
  if (typeof definition.id !== 'string' || definition.id.length === 0) {
    throw new Error('definePlugin: "id" is required and must be a string');
  }
  if (typeof definition.register !== 'function') {
    throw new Error(`definePlugin: "register" must be a function (plugin: ${definition.id})`);
  }
  return definition;
}
