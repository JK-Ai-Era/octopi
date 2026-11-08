/** Host-level effective contribution registry; per-Agent buses are mount projections. */

import type { PluginManifest } from './manifest.js';
import type { HookServiceRegistration } from '../hooks/types.js';

export interface PluginServiceRecord extends HookServiceRegistration {
  pluginId: string;
}
import type { PluginApi, PluginProviderFactory, PluginChannelFactory } from './api.js';
import type { PluginCommandRegistration, PluginToolContribution, OrderedHookEntry } from './api.js';
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

/** An immutable published contribution set. Mutations are staged by PluginLoader. */
export class PluginContributionRegistry {
  private plugins = new Map<string, RegisteredPlugin>();
  private tools: PluginToolRecord[] = [];
  private commands: PluginCommandRecord[] = [];
  private hooks: OrderedHookEntry[] = [];
  private services: PluginServiceRecord[] = [];
  private providers: PluginProviderRecord[] = [];
  private channels: PluginChannelRecord[] = [];
  private owners = new Map<string, string>();

  /** Replace the effective set only after all staged registrations validate. */
  publish(plugins: readonly RegisteredPlugin[]): void {
    const next = new PluginContributionRegistry();
    for (const plugin of plugins) {
      next.plugins.set(plugin.manifest.id, plugin);
      const staged = readStaging(plugin.api);
      for (const tool of staged.tools) {
        next.addOwner('tool', tool.definition.name, plugin.manifest.id);
        next.tools.push({ pluginId: plugin.manifest.id, ...tool });
      }
      for (const command of staged.commands) {
        next.addOwner('command', command.name, plugin.manifest.id);
        next.commands.push({ pluginId: plugin.manifest.id, ...command });
      }
      for (const entries of staged.hooks.values()) next.hooks.push(...entries);
      for (const service of staged.services) {
        next.addOwner('service', service.serviceId, plugin.manifest.id);
        next.services.push({ pluginId: plugin.manifest.id, ...service });
      }
      for (const provider of staged.providers) {
        next.addOwner('provider', provider.id, plugin.manifest.id);
        next.providers.push({ pluginId: plugin.manifest.id, ...provider });
      }
      for (const channel of staged.channels) {
        next.addOwner('channel', channel.id, plugin.manifest.id);
        next.channels.push({ pluginId: plugin.manifest.id, ...channel });
      }
    }
    const replyOwners = next.hooks.filter((entry) => entry.hookName === 'before_agent_reply');
    if (replyOwners.length > 1) {
      throw new Error(`Override hook before_agent_reply has multiple owners: ${replyOwners.map((entry) => entry.pluginId).join(', ')}`);
    }
    this.plugins = next.plugins;
    this.tools = next.tools;
    this.commands = next.commands;
    this.hooks = next.hooks;
    this.services = next.services;
    this.providers = next.providers;
    this.channels = next.channels;
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
  getTools(): PluginToolRecord[] { return [...this.tools]; }
  getCommands(): PluginCommandRecord[] { return [...this.commands]; }
  getHooks(): OrderedHookEntry[] { return [...this.hooks]; }
  getServices(): PluginServiceRecord[] { return [...this.services]; }
  getProviders(): PluginProviderRecord[] { return [...this.providers]; }
  getChannels(): PluginChannelRecord[] { return [...this.channels]; }
}
