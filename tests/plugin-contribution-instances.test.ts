/**
 * Contribution instance registry semantics (P6-3): Host-acceptance births,
 * physical + logical retirement, and the PluginApi.getContributionInstance
 * narrow lookup that replaced the weixin module-closure bridge.
 */

import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import weixinPlugin from '../examples/plugins/weixin-clawbot/index.mjs';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import { PluginContributionRegistry } from '../packages/engine/src/harness/extension/plugin-ecosystem/plugins/contribution-registry.js';
import type { RegisteredPlugin } from '../packages/engine/src/harness/extension/plugin-ecosystem/plugins/contribution-registry.js';
import { PluginApi } from '../packages/engine/src/harness/extension/plugin-ecosystem/plugins/api.js';
import type { PluginManifest } from '../packages/engine/src/harness/extension/plugin-ecosystem/plugins/manifest.js';
import { createChannelAdapterFromConfig, createProviderFromConfig } from '../packages/engine/src/config.js';

function manifestWith(id: string): PluginManifest {
  return {
    id,
    apiVersion: '1',
    version: '1.0.0',
    name: id,
    entry: 'index.mjs',
    engine: { octopi: '>=0' },
    configSchema: { type: 'object' },
    contributes: {},
  };
}

function makePlugin(id: string, register: (api: PluginApi) => void): RegisteredPlugin {
  const api = new PluginApi({ id, name: id, version: '1.0.0', source: 'test', rootDir: '/tmp', pluginConfig: {} });
  register(api);
  return { manifest: manifestWith(id), definition: { id, register }, api, path: `/tmp/${id}` };
}

function fakeChannelAdapter(): { calls: string[]; adapter: { name: string; start(): Promise<void>; send(): Promise<void>; stop(): Promise<void>; pair(): Promise<string> } } {
  const calls: string[] = [];
  return {
    calls,
    adapter: {
      name: 'weixin',
      start: async () => { calls.push('start'); },
      send: async () => { calls.push('send'); },
      stop: async () => { calls.push('stop'); },
      pair: async () => 'scanned',
    },
  };
}

const CHANNEL_CTX = { channelName: 'weixin', apiKey: '', options: {} };

function apiLookup(plugin: RegisteredPlugin, kind: 'provider' | 'channel', id: string): object {
  return plugin.api.getContributionInstance(kind, id);
}

describe('contribution instance registry', () => {
  it('registers the accepted instance and the plugin tool sees the same object', async () => {
    const { adapter } = fakeChannelAdapter();
    let toolHandler: (() => Promise<unknown>) | undefined;
    const plugin = makePlugin('weixin', (api) => {
      api.registerChannel('weixin', async () => adapter);
      toolHandler = async () => (api.getContributionInstance('channel', 'weixin') as typeof adapter).pair();
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    const record = registry.getChannels()[0];

    const created = await record.factory(CHANNEL_CTX);
    expect(created).toBe(adapter);
    // Birth = Host acceptance: nothing is tracked before acceptInstance.
    expect(() => apiLookup(plugin, 'channel', 'weixin')).toThrow(
      'Plugin "weixin" channel "weixin" has no live instance (the Host has not instantiated it)',
    );
    record.acceptInstance?.(adapter, 'weixin');
    expect(apiLookup(plugin, 'channel', 'weixin')).toBe(adapter);
    await expect(toolHandler!()).resolves.toBe('scanned');
  });

  it('reports a real error when the Host has not instantiated the contribution', async () => {
    const plugin = makePlugin('p', (api) => {
      api.registerChannel('weixin', async () => fakeChannelAdapter().adapter);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);

    expect(() => apiLookup(plugin, 'channel', 'weixin')).toThrow(
      'Plugin "p" channel "weixin" has no live instance (the Host has not instantiated it)',
    );
  });

  it('retires the entry when the Host stops the adapter, keeping the real work', async () => {
    const { calls, adapter } = fakeChannelAdapter();
    const plugin = makePlugin('p', (api) => {
      api.registerChannel('weixin', async () => adapter);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    registry.getChannels()[0].acceptInstance?.(adapter, 'weixin');

    await adapter.stop();
    expect(calls).toEqual(['stop']);
    expect(() => apiLookup(plugin, 'channel', 'weixin')).toThrow(
      'Plugin "p" channel "weixin" has no live instance (its instance was retired)',
    );
  });

  it('records retirement when stop() is requested even if it fails', async () => {
    const adapter = {
      name: 'weixin',
      start: async () => {},
      send: async () => {},
      stop: async () => { throw new Error('stop failed'); },
    };
    const plugin = makePlugin('p', (api) => {
      api.registerChannel('weixin', async () => adapter);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    registry.getChannels()[0].acceptInstance?.(adapter, 'weixin');

    await expect(adapter.stop()).rejects.toThrow('stop failed');
    expect(() => apiLookup(plugin, 'channel', 'weixin')).toThrow(/its instance was retired/);
  });

  it('defines dispose as a retirement marker when the provider has none', async () => {
    const provider = { name: 'p1' };
    const plugin = makePlugin('p', (api) => {
      api.registerProvider('pr', async () => provider as never);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    registry.getProviders()[0].acceptInstance?.(provider, 'alpha');

    expect(apiLookup(plugin, 'provider', 'pr')).toBe(provider);
    expect(typeof (provider as { dispose?: unknown }).dispose).toBe('function');
    await (provider as unknown as { dispose(): void }).dispose();
    expect(() => apiLookup(plugin, 'provider', 'pr')).toThrow(/its instance was retired/);
  });

  it('wraps an existing provider dispose: real disposal still runs', async () => {
    const disposed: string[] = [];
    const provider = { name: 'p1', dispose: () => { disposed.push('x'); } };
    const plugin = makePlugin('p', (api) => {
      api.registerProvider('pr', async () => provider as never);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    registry.getProviders()[0].acceptInstance?.(provider, 'alpha');

    await provider.dispose();
    expect(disposed).toEqual(['x']);
    expect(() => apiLookup(plugin, 'provider', 'pr')).toThrow(/its instance was retired/);
  });

  it('refuses an ambiguous lookup when several config identities are live', async () => {
    const plugin = makePlugin('p', (api) => {
      api.registerProvider('pr', async (context) => ({ name: context.providerName }) as never);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    const record = registry.getProviders()[0];
    const alpha = { name: 'alpha' };
    const beta = { name: 'beta' };
    record.acceptInstance?.(alpha, 'alpha');
    record.acceptInstance?.(beta, 'beta');

    expect(() => apiLookup(plugin, 'provider', 'pr')).toThrow(
      'Plugin "p" provider "pr" has 2 live instances ("alpha", "beta"): getContributionInstance requires exactly one',
    );
    // Partial retirement recovers the lookup.
    await (beta as unknown as { dispose(): void }).dispose();
    expect(apiLookup(plugin, 'provider', 'pr')).toBe(alpha);
  });

  it('supersedes the previous instance on hot-reload replace (same config identity)', async () => {
    const plugin = makePlugin('p', (api) => {
      api.registerProvider('pr', async (context) => ({ name: context.providerName }) as never);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    const record = registry.getProviders()[0];
    const old = { name: 'alpha' };
    const fresh = { name: 'alpha' };
    record.acceptInstance?.(old, 'alpha');
    record.acceptInstance?.(fresh, 'alpha');

    // No false ambiguity during the gateway's dispose grace window: the
    // superseded instance is retired logically at replacement.
    expect(apiLookup(plugin, 'provider', 'pr')).toBe(fresh);
    expect(() => apiLookup(plugin, 'provider', 'pr')).not.toThrow();
  });

  it('re-acceptance revives a retired singleton (same config identity)', async () => {
    const shared = { name: 'p1' };
    const plugin = makePlugin('p', (api) => {
      api.registerProvider('pr', async () => shared as never);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    const record = registry.getProviders()[0];
    record.acceptInstance?.(shared, 'alpha');
    record.acceptInstance?.(shared, 'alpha');

    // Dedupe: one entry, one retire.
    expect(apiLookup(plugin, 'provider', 'pr')).toBe(shared);
    await (shared as unknown as { dispose(): void }).dispose();
    expect(() => apiLookup(plugin, 'provider', 'pr')).toThrow(/its instance was retired/);

    // The Host serves the same product again: it is live again as of now.
    record.acceptInstance?.(shared, 'alpha');
    expect(apiLookup(plugin, 'provider', 'pr')).toBe(shared);
  });

  it('refuses lookup of a key that is not a contribution of this plugin', () => {
    const plugin = makePlugin('p', (api) => {
      api.registerChannel('mine', async () => fakeChannelAdapter().adapter);
    });

    expect(() => apiLookup(plugin, 'channel', 'weixin')).toThrow(
      'Plugin "p" cannot look up channel "weixin": not a contribution of this plugin',
    );
  });

  it('refuses cross-plugin lookup even when the other plugin staged the key', async () => {
    const owner = makePlugin('owner', (api) => {
      api.registerChannel('weixin', async () => fakeChannelAdapter().adapter);
    });
    const stranger = makePlugin('stranger', () => {});
    const registry = new PluginContributionRegistry();
    registry.publish([owner, stranger]);
    registry.getChannels()[0].acceptInstance?.(fakeChannelAdapter().adapter, 'weixin');

    expect(() => apiLookup(stranger, 'channel', 'weixin')).toThrow(/not a contribution of this plugin/);
    expect(apiLookup(owner, 'channel', 'weixin')).toBeDefined();
  });

  it('rejects unknown instance kinds with a real error (JS authors)', () => {
    const plugin = makePlugin('p', (api) => {
      api.registerChannel('chan', async () => fakeChannelAdapter().adapter);
    });

    expect(() => plugin.api.getContributionInstance('service' as never, 'chan')).toThrow(
      'Plugin "p" cannot look up instances of kind "service": expected "provider" or "channel"',
    );
  });

  it('never adds stop to a broken adapter and never tracks it — the Host contract check stays honest', async () => {
    const broken = { name: 'weixin' };
    const plugin = makePlugin('p', (api) => {
      api.registerChannel('weixin', async () => broken as never);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    registry.getChannels()[0].acceptInstance?.(broken, 'weixin');

    expect((broken as { stop?: unknown }).stop).toBeUndefined();
    expect(() => apiLookup(plugin, 'channel', 'weixin')).toThrow(
      'Plugin "p" channel "weixin" has no live instance (the Host has not instantiated it)',
    );
  });

  it('does not track frozen instances and never throws from the registry', async () => {
    const frozen = Object.freeze({ name: 'weixin', stop: () => {} });
    const plugin = makePlugin('p', (api) => {
      api.registerChannel('weixin', async () => frozen as never);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);

    expect(() => registry.getChannels()[0].acceptInstance?.(frozen, 'weixin')).not.toThrow();
    expect(() => apiLookup(plugin, 'channel', 'weixin')).toThrow(/has no live instance/);
  });

  it('survives repeated publish without losing or double-registering instances', async () => {
    const { adapter } = fakeChannelAdapter();
    const plugin = makePlugin('p', (api) => {
      api.registerChannel('weixin', async () => adapter);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    registry.getChannels()[0].acceptInstance?.(adapter, 'weixin');
    registry.publish([plugin]);

    expect(apiLookup(plugin, 'channel', 'weixin')).toBe(adapter);
  });

  it('real Host paths: createChannelAdapterFromConfig accepts the instance, rejects leave nothing tracked', async () => {
    const { adapter } = fakeChannelAdapter();
    const plugin = makePlugin('p', (api) => {
      api.registerChannel('weixin', async () => adapter);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    const record = registry.getChannels()[0];

    const created = await createChannelAdapterFromConfig({ plugin: 'weixin', apiKey: '', options: {} }, () => record);
    expect(created).toBe(adapter);
    expect(apiLookup(plugin, 'channel', 'weixin')).toBe(adapter);
  });

  it('real Host paths: a rejected factory product never becomes a tracked instance', async () => {
    const wrong = { name: 'wrong', start: async () => {}, send: async () => {}, stop: async () => {} };
    const plugin = makePlugin('p', (api) => {
      api.registerChannel('weixin', async () => wrong);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    const record = registry.getChannels()[0];

    await expect(
      createChannelAdapterFromConfig({ plugin: 'weixin', apiKey: '', options: {} }, () => record),
    ).rejects.toThrow(/adapter.name "wrong"/);
    // No phantom: the rejected product is not a live instance.
    expect(() => apiLookup(plugin, 'channel', 'weixin')).toThrow(
      'Plugin "p" channel "weixin" has no live instance (the Host has not instantiated it)',
    );
  });

  it('real Host paths: createProviderFromConfig registers the factory product the Host routes', async () => {
    const product = {
      name: 'alpha',
      chat: async () => ({}) as never,
      stream: async () => (async function* () { })() as never,
      isAvailable: async () => true,
    };
    const plugin = makePlugin('p', (api) => {
      api.registerProvider('pr', async () => product as never);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    const record = registry.getProviders()[0];

    const served = await createProviderFromConfig('alpha', { baseUrl: 'https://example.invalid', plugin: 'pr', models: [] }, { resolvePluginProvider: () => record });
    expect(served.name).toBe('alpha');
    expect(apiLookup(plugin, 'provider', 'pr')).toBe(served);
  });

  it('weixin example plugin: the weixin_pair tool bridges through the registry, not a closure', async () => {
    const api = new PluginApi({ id: 'weixin', name: 'weixin', version: '1.0.0', source: 'test', rootDir: '/tmp', pluginConfig: {} });
    // The example's own d.mts narrows the api view to its plugin-specific
    // adapter type; the real PluginApi returns the SPI structural view.
    weixinPlugin.register(api as never);
    const registry = new PluginContributionRegistry();
    registry.publish([{ manifest: manifestWith('weixin'), definition: { id: 'weixin', register: (a) => weixinPlugin.register(a as never) }, api, path: '/tmp/weixin' }]);

    const tool = registry.getTools().find((record) => record.definition.name === 'weixin_pair');
    expect(tool).toBeDefined();
    const handler = tool!.handler as unknown as () => Promise<unknown>;
    // Before the Host accepts the channel: a real state error, not a crash.
    await expect(handler()).rejects.toThrow(
      'Plugin "weixin" channel "weixin" has no live instance (the Host has not instantiated it)',
    );

    const created = await registry.getChannels()[0].factory({
      channelName: 'weixin',
      apiKey: '',
      options: { statePath: join(tmpdir(), 'octopi-p63-weixin-state.json') },
    });
    registry.getChannels()[0].acceptInstance?.(created, 'weixin');
    // The bridge reaches the very instance the Host serves.
    expect(api.getContributionInstance('channel', 'weixin')).toBe(created);
    // Post-retirement the tool bridge reports the real lifecycle state.
    await (created as { stop(): Promise<void> }).stop();
    await expect(handler()).rejects.toThrow(
      'Plugin "weixin" channel "weixin" has no live instance (its instance was retired)',
    );
  });

  it('real Host paths: a rejected provider product never becomes a tracked instance', async () => {
    const wrong = { name: 'wrong', chat: async () => ({}) as never, stream: async () => (async function* () { })() as never, isAvailable: async () => true };
    const plugin = makePlugin('p', (api) => {
      api.registerProvider('pr', async () => wrong as never);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    const record = registry.getProviders()[0];

    await expect(
      createProviderFromConfig('alpha', { baseUrl: 'https://example.invalid', plugin: 'pr', models: [] }, { resolvePluginProvider: () => record }),
    ).rejects.toThrow(/provider.name "wrong"/);
    expect(() => apiLookup(plugin, 'provider', 'pr')).toThrow(
      'Plugin "p" provider "pr" has no live instance (the Host has not instantiated it)',
    );
  });

  it('does not track frozen provider products and never throws from the registry', async () => {
    const frozen = Object.freeze({ name: 'alpha', chat: async () => ({}) as never, stream: async () => (async function* () { })() as never, isAvailable: async () => true });
    const plugin = makePlugin('p', (api) => {
      api.registerProvider('pr', async () => frozen as never);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    const record = registry.getProviders()[0];

    expect(record.acceptInstance?.(frozen, 'alpha')).toBe(false);
    expect(() => apiLookup(plugin, 'provider', 'pr')).toThrow(/has no live instance/);
  });

  it('wire-dump decoration: the lookup returns the factory product and dispose forwarding still retires it', async () => {
    const product = { name: 'alpha', chat: async () => ({}) as never, stream: async () => (async function* () { })() as never, isAvailable: async () => true };
    const plugin = makePlugin('p', (api) => {
      api.registerProvider('pr', async () => product as never);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    const record = registry.getProviders()[0];
    const sink = { capture: () => {}, flush: () => [] };

    const served = await createProviderFromConfig(
      'alpha',
      { baseUrl: 'https://example.invalid', plugin: 'pr', models: [] },
      { wireDump: sink as never, resolvePluginProvider: () => record },
    );
    // The Host routes through a decorator copy; the lookup returns the product
    // (plugin-specific methods live only there).
    expect(served).not.toBe(product);
    expect(apiLookup(plugin, 'provider', 'pr')).toBe(product);
    // The decorator's dispose forwarding closes the retirement chain
    // (acceptance runs before decoration — that ordering is the contract).
    await (served as unknown as { dispose(): void }).dispose();
    expect(() => apiLookup(plugin, 'provider', 'pr')).toThrow(/its instance was retired/);
  });

  it('logical retirement at routing removal: retireInstance marks entries immediately', async () => {
    const { adapter } = fakeChannelAdapter();
    const plugin = makePlugin('p', (api) => {
      api.registerChannel('weixin', async () => adapter);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    registry.getChannels()[0].acceptInstance?.(adapter, 'weixin');

    registry.retireInstance(adapter);
    expect(() => apiLookup(plugin, 'channel', 'weixin')).toThrow(/its instance was retired/);
    // Idempotent, and the physical backstop still works.
    registry.retireInstance(adapter);
    await adapter.stop();
  });

  it('aborted acceptance rolls back and resurrects the superseded instance', async () => {
    const oldInstance = { name: 'alpha', dispose: () => {} };
    const newInstance = { name: 'alpha', dispose: () => {} };
    const plugin = makePlugin('p', (api) => {
      api.registerProvider('pr', async (context) => (context.providerName === 'fresh' ? newInstance : oldInstance) as never);
    });
    const registry = new PluginContributionRegistry();
    registry.publish([plugin]);
    const record = registry.getProviders()[0];
    record.acceptInstance?.(oldInstance, 'alpha');
    record.acceptInstance?.(newInstance, 'alpha');
    expect(apiLookup(plugin, 'provider', 'pr')).toBe(newInstance);

    // The Host aborts before installing the pre-built instance:
    registry.discardInstance(newInstance);
    expect(apiLookup(plugin, 'provider', 'pr')).toBe(oldInstance);
    // Discarding a non-current instance is a no-op.
    registry.discardInstance(newInstance);
    expect(apiLookup(plugin, 'provider', 'pr')).toBe(oldInstance);
  });

  it('rejects non-string ids with a real error (JS authors)', () => {
    const plugin = makePlugin('p', (api) => {
      api.registerChannel('chan', async () => fakeChannelAdapter().adapter);
    });

    expect(() => plugin.api.getContributionInstance('channel', 42 as never)).toThrow(
      'Plugin "p" cannot look up channel instance "42": id must be a string',
    );
  });
});

describe('gateway resetRuntimeConfig retirement (P6-3 leak fix)', () => {
  it('routes displaced providers through the retirement grace window instead of bare delete/overwrite', async () => {
    const gateway = new Gateway({ agents: [], knowledge: { service: { manageLocal: false } } }, new InMemorySessionStore());
    const disposed: string[] = [];
    const mk = (tag: string) => ({
      name: 'a',
      chat: async () => ({}) as never,
      stream: async () => (async function* () { })() as never,
      isAvailable: async () => true,
      dispose: () => { disposed.push(tag); },
    });
    const old = mk('old');
    const fresh = mk('fresh');
    gateway.resetRuntimeConfig([{ name: 'a', config: {}, instance: old as never }], [], undefined);

    vi.useFakeTimers();
    try {
      // Replace: the displaced instance enters the grace window (was leaked before).
      gateway.resetRuntimeConfig([{ name: 'a', config: {}, instance: fresh as never }], [], undefined);
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
      expect(disposed).toEqual(['old']);

      // Remove without replacement: same treatment.
      gateway.resetRuntimeConfig([], [], undefined);
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
      expect(disposed).toEqual(['old', 'fresh']);
    } finally {
      vi.useRealTimers();
    }
  });
});
