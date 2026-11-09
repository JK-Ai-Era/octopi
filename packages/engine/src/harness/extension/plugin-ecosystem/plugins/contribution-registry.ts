/** Host-level effective contribution registry; per-Agent buses are mount projections. */

import type { PluginManifest } from './manifest.js';
import type { HookServiceRegistration } from '../hooks/types.js';

export interface PluginServiceRecord extends HookServiceRegistration {
  pluginId: string;
}
import type { PluginApi, PluginProviderFactory, PluginChannelFactory } from './api.js';
import type { PluginCommandRegistration, PluginToolContribution, OrderedHookEntry } from './api.js';
import type { ContributionSink } from './contribution-kinds.js';
import { CONTRIBUTION_KINDS } from './contribution-kinds.js';
import { readStaging } from './staging.js';

export interface RegisteredPlugin {
  manifest: PluginManifest;
  definition: { id: string; register(api: PluginApi): void | Promise<void> };
  api: PluginApi;
  path: string;
}

export interface PluginToolRecord extends PluginToolContribution {
  pluginId: string;
}

export interface PluginCommandRecord extends PluginCommandRegistration {
  pluginId: string;
}

/** A published provider factory contribution; globally unique id, like services. */
export interface PluginProviderRecord {
  pluginId: string;
  id: string;
  factory: PluginProviderFactory;
}

/** A published channel factory contribution; globally unique id, like providers. */
export interface PluginChannelRecord {
  pluginId: string;
  id: string;
  factory: PluginChannelFactory;
}

function emptySink(): ContributionSink {
  return { tools: [], commands: [], hooks: [], services: [], providers: [], channels: [] };
}

/** An immutable published contribution set. Mutations are staged by PluginLoader. */
export class PluginContributionRegistry {
  private plugins = new Map<string, RegisteredPlugin>();
  private records: ContributionSink = emptySink();
  private owners = new Map<string, string>();

  /** Replace the effective set only after all staged registrations validate. */
  publish(plugins: readonly RegisteredPlugin[]): void {
    const next = new PluginContributionRegistry();
    for (const plugin of plugins) {
      next.plugins.set(plugin.manifest.id, plugin);
      const staged = readStaging(plugin.api);
      for (const kind of CONTRIBUTION_KINDS) {
        kind.forEachStaged(staged, (key, entry) => {
          if (kind.globallyUnique) next.addOwner(kind.label, key, plugin.manifest.id);
          kind.collect(next.records, plugin.manifest.id, entry);
        });
      }
    }
    const replyOwners = next.records.hooks.filter((entry) => entry.hookName === 'before_agent_reply');
    if (replyOwners.length > 1) {
      throw new Error(`Override hook before_agent_reply has multiple owners: ${replyOwners.map((entry) => entry.pluginId).join(', ')}`);
    }
    this.plugins = next.plugins;
    this.records = next.records;
    this.owners = next.owners;
  }

  /** Clear the effective set before a fresh discovery attempt. */
  clear(): void {
    this.publish([]);
  }

  private addOwner(type: string, id: string, pluginId: string): void {
    const key = `${type}:${id}`;
    const owner = this.owners.get(key);
    if (owner !== undefined) {
      throw new Error(`Contribution conflict ${key}: "${owner}" and "${pluginId}"`);
    }
    this.owners.set(key, pluginId);
  }

  getPlugins(): RegisteredPlugin[] { return [...this.plugins.values()]; }
  getPlugin(id: string): RegisteredPlugin | undefined { return this.plugins.get(id); }
  getTools(): PluginToolRecord[] { return [...this.records.tools]; }
  getCommands(): PluginCommandRecord[] { return [...this.records.commands]; }
  getHooks(): OrderedHookEntry[] { return [...this.records.hooks]; }
  getServices(): PluginServiceRecord[] { return [...this.records.services]; }
  getProviders(): PluginProviderRecord[] { return [...this.records.providers]; }
  getChannels(): PluginChannelRecord[] { return [...this.records.channels]; }
}
