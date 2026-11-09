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
import { readInstanceTable } from './contribution-instances.js';
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
  /**
   * Host-private instance-registration hook (see contribution-kinds
   * `bindInstances`). Hosts MUST call it with the accepted factory product —
   * after contract validation, before any Host-side decorator wraps it — so
   * the instance registry's notion of "live" matches what the Host routes to.
   */
  acceptInstance?(instance: object, label: string): boolean;
}

/** A published channel factory contribution; globally unique id, like providers. */
export interface PluginChannelRecord {
  pluginId: string;
  id: string;
  factory: PluginChannelFactory;
  /** Host-private instance-registration hook; see PluginProviderRecord.acceptInstance. */
  acceptInstance?(instance: object, label: string): boolean;
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
          const bound = kind.bindInstances?.(entry, readInstanceTable(plugin.api)) ?? entry;
          if (kind.bindInstances !== undefined && typeof (bound as { acceptInstance?: unknown }).acceptInstance !== 'function') {
            throw new Error(`contribution kind "${kind.label}" is factory-backed but bindInstances did not wire acceptInstance`);
          }
          kind.collect(next.records, plugin.manifest.id, bound);
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

  /**
   * Roll back an accepted-but-never-installed instance across all plugin
   * instance tables (see ContributionInstanceTable.discardByInstance).
   *
   * @param instance - The instance the Host validated but never routed to
   */
  discardInstance(instance: object): void {
    for (const plugin of this.plugins.values()) readInstanceTable(plugin.api).discardByInstance(instance);
  }

  /**
   * Logical retirement by instance identity across all plugin instance tables
   * (see ContributionInstanceTable.retireByInstance) — called when the Host
   * stops routing to an instance.
   *
   * @param instance - The instance the Host stopped routing to
   */
  retireInstance(instance: object): void {
    for (const plugin of this.plugins.values()) readInstanceTable(plugin.api).retireByInstance(instance);
  }
}
