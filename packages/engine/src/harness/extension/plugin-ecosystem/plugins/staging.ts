/** Host-private staging storage. Not exported through the author SDK. */

import type { PluginApi } from './api.js';
import type { OrderedHookEntry, PluginCommandRegistration, PluginToolContribution } from './api.js';
import type { PluginHookName } from './manifest.js';

export interface StagedContributions {
  tools: PluginToolContribution[];
  commands: PluginCommandRegistration[];
  hooks: Map<PluginHookName, OrderedHookEntry[]>;
}

const staged = new WeakMap<PluginApi, StagedContributions>();

/** Called only by the host when constructing an author API. */
export function createStaging(api: PluginApi): StagedContributions {
  const value: StagedContributions = { tools: [], commands: [], hooks: new Map() };
  staged.set(api, value);
  return value;
}

/** Read the host-owned staging snapshot while validating or publishing a plugin. */
export function readStaging(api: PluginApi): StagedContributions {
  const value = staged.get(api);
  if (!value) throw new Error('PluginApi was not created by the host loader');
  return value;
}
