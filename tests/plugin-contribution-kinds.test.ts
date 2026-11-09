/** Contribution-kind table semantics: the pipeline invariants every kind shares. */

import { describe, expect, it } from 'vitest';
import {
  assertManifestCoverage,
  assertManifestKeysUnique,
  assertStagingKeyFree,
  CONTRIBUTION_KINDS,
  declaredClaims,
  stageContribution,
} from '../packages/engine/src/harness/extension/plugin-ecosystem/plugins/contribution-kinds.js';
import type { ContributionField, ContributionSink } from '../packages/engine/src/harness/extension/plugin-ecosystem/plugins/contribution-kinds.js';
import { PluginContributionRegistry } from '../packages/engine/src/harness/extension/plugin-ecosystem/plugins/contribution-registry.js';
import type { RegisteredPlugin } from '../packages/engine/src/harness/extension/plugin-ecosystem/plugins/contribution-registry.js';
import { PluginApi } from '../packages/engine/src/harness/extension/plugin-ecosystem/plugins/api.js';
import type { PluginManifest } from '../packages/engine/src/harness/extension/plugin-ecosystem/plugins/manifest.js';
import type { StagedContributions } from '../packages/engine/src/harness/extension/plugin-ecosystem/plugins/staging.js';

function emptyStaged(): StagedContributions {
  return { tools: [], commands: [], hooks: new Map(), services: [], providers: [], channels: [] };
}

function emptySink(): ContributionSink {
  return { tools: [], commands: [], hooks: [], services: [], providers: [], channels: [] };
}

function manifestWith(id: string, contributes: Record<string, unknown>): PluginManifest {
  return {
    id,
    apiVersion: '1',
    version: '1.0.0',
    name: id,
    entry: 'index.mjs',
    engine: { octopi: '>=0' },
    configSchema: { type: 'object' },
    contributes: contributes as PluginManifest['contributes'],
  };
}

function makePlugin(id: string, register: (api: PluginApi) => void): RegisteredPlugin {
  const api = new PluginApi({ id, name: id, version: '1.0.0', source: 'test', rootDir: '/tmp', pluginConfig: {} });
  register(api);
  return { manifest: manifestWith(id, {}), definition: { id, register }, api, path: `/tmp/${id}` };
}

describe('contribution-kind table coverage', () => {
  it('exposes every staging slot exactly once', () => {
    const fields = CONTRIBUTION_KINDS.map((kind) => kind.field);
    expect(new Set(fields).size).toBe(fields.length);
    expect([...fields].sort()).toEqual(['channels', 'commands', 'hooks', 'providers', 'services', 'tools']);
  });

  it('forEachStaged visits the matching staging slot for every kind', () => {
    const staged = emptyStaged();
    staged.tools.push({ definition: { name: 't', description: '', parameters: {}, capabilities: ['fs-read'] }, handler: (async () => ({})) as never, optional: false });
    staged.commands.push({ name: 'c', handler: async () => {} });
    staged.hooks.set('agent_end', [{ pluginId: 'p', hookName: 'agent_end' as const, handler: (() => {}) as never, phase: 'single' as const, priority: 0 }]);
    staged.services.push({ serviceId: 's', start: async () => {}, timeoutMs: 1 });
    staged.providers.push({ id: 'pr', factory: (() => ({})) as never });
    staged.channels.push({ id: 'ch', factory: (() => ({})) as never });
    const counts = CONTRIBUTION_KINDS.map((kind) => {
      let count = 0;
      kind.forEachStaged(staged, () => { count += 1; });
      return [kind.field, count] as const;
    });
    expect(Object.fromEntries(counts)).toEqual({ tools: 1, commands: 1, hooks: 1, services: 1, providers: 1, channels: 1 });
  });

  it('keys are the declared identity fields', () => {
    const byField = new Map(CONTRIBUTION_KINDS.map((kind) => [kind.field, kind]));
    const seen = (field: ContributionField, staged: StagedContributions): string[] => {
      const keys: string[] = [];
      byField.get(field)!.forEachStaged(staged, (key) => keys.push(key));
      return keys;
    };
    const staged = emptyStaged();
    staged.tools.push({ definition: { name: 'x' } } as never);
    staged.commands.push({ name: 'x' } as never);
    staged.hooks.set('agent_end', [{ hookName: 'agent_end' } as never]);
    staged.services.push({ serviceId: 'x' } as never);
    staged.providers.push({ id: 'x' } as never);
    staged.channels.push({ id: 'x' } as never);
    expect(seen('tools', staged)).toEqual(['x']);
    expect(seen('commands', staged)).toEqual(['x']);
    expect(seen('hooks', staged)).toEqual(['agent_end']);
    expect(seen('services', staged)).toEqual(['x']);
    expect(seen('providers', staged)).toEqual(['x']);
    expect(seen('channels', staged)).toEqual(['x']);
  });
});

describe('staging uniqueness semantics', () => {
  it('rejects a second registration of the same key per plugin with the kind label', () => {
    const staged = emptyStaged();
    const kind = CONTRIBUTION_KINDS.find((k) => k.field === 'providers')!;
    stageContribution('p', kind, staged, { id: 'a', factory: (() => ({})) as never });
    expect(() => stageContribution('p', kind, staged, { id: 'a', factory: (() => ({})) as never }))
      .toThrow('Plugin "p" registered duplicate provider "a"');
    expect(() => stageContribution('p', kind, staged, { id: 'b', factory: (() => ({})) as never })).not.toThrow();
  });

  it('hooks are multi-handler per name: no per-plugin key uniqueness', () => {
    const staged = emptyStaged();
    const entry = { pluginId: 'p', hookName: 'agent_end' as const, handler: (() => {}) as never, phase: 'single' as const, priority: 0 };
    staged.hooks.set('agent_end', [entry]);
    const kind = CONTRIBUTION_KINDS.find((k) => k.field === 'hooks')!;
    expect(kind.perPluginUnique).toBe(false);
    expect(() => assertStagingKeyFree('p', kind, staged, 'agent_end')).not.toThrow();
    expect(kind.globallyUnique).toBe(false);
  });

  it('hooks.push keeps entries sorted by descending priority', () => {
    const staged = emptyStaged();
    const kind = CONTRIBUTION_KINDS.find((k) => k.field === 'hooks')!;
    const entry = (priority: number) => ({ pluginId: 'p', hookName: 'agent_end' as const, handler: (() => {}) as never, phase: 'single' as const, priority });
    stageContribution('p', kind, staged, entry(0));
    stageContribution('p', kind, staged, entry(10));
    stageContribution('p', kind, staged, entry(5));
    expect(staged.hooks.get('agent_end')!.map((e) => e.priority)).toEqual([10, 5, 0]);
  });

  it('reserved channel labels cannot be claimed', () => {
    const kind = CONTRIBUTION_KINDS.find((k) => k.field === 'channels')!;
    const staged = emptyStaged();
    expect(() => stageContribution('p', kind, staged, { id: 'http', factory: (() => ({})) as never }))
      .toThrow('Plugin "p" cannot register channel "http": reserved by built-in adapters');
    expect(() => stageContribution('p', kind, staged, { id: 'ws', factory: (() => ({})) as never })).toThrow('reserved by built-in adapters');
    expect(() => stageContribution('p', kind, staged, { id: 'feishu', factory: (() => ({})) as never })).not.toThrow();
  });
});

describe('manifest claims and coverage', () => {
  it('claims only exist for globally unique kinds', () => {
    const manifest = manifestWith('p', { providers: ['a'], channels: ['c'], hooks: ['agent_end'] });
    const claims = CONTRIBUTION_KINDS.flatMap((kind) => declaredClaims(kind, manifest));
    expect(claims.sort()).toEqual(['channel:c', 'provider:a']);
  });

  it('coverage rejects unregistered declarations and undeclared registrations', () => {
    const kind = CONTRIBUTION_KINDS.find((k) => k.field === 'providers')!;
    const staged = emptyStaged();
    staged.providers.push({ id: 'actual', factory: (() => ({})) as never });

    expect(() => assertManifestCoverage(kind, manifestWith('p', { providers: ['actual', 'ghost'] }), staged))
      .toThrow('Declared provider "ghost" was not registered');
    expect(() => assertManifestCoverage(kind, manifestWith('p', { providers: ['other'] }), staged))
      .toThrow('Provider "actual" is not declared in manifest');
  });

  it('command sessionOps must match the manifest exactly', () => {
    const kind = CONTRIBUTION_KINDS.find((k) => k.field === 'commands')!;
    const staged = emptyStaged();
    staged.commands.push({ name: 'c', handler: async () => {}, sessionOps: ['abort_run'] });
    const manifest = manifestWith('p', { commands: [{ name: 'c', sessionOps: ['new_session'] }] });
    expect(() => assertManifestCoverage(kind, manifest, staged)).toThrow('Command "c" sessionOps differ from manifest');
    const ok = manifestWith('p', { commands: [{ name: 'c', sessionOps: ['abort_run'] }] });
    expect(() => assertManifestCoverage(kind, ok, staged)).not.toThrow();
  });

  it('manifest key uniqueness rejects duplicate declarations', () => {
    expect(() => assertManifestKeysUnique(manifestWith('p', { providers: ['a', 'a'] })))
      .toThrow('Plugin manifest contributes.providers contains duplicate entries');
    expect(() => assertManifestKeysUnique(manifestWith('p', { commands: [{ name: 'c' }, { name: 'c' }] })))
      .toThrow('Plugin manifest contributes.commands contains duplicate entries');
  });

  it('publish sink receives one record per staged entry', () => {
    const sink = emptySink();
    const kind = CONTRIBUTION_KINDS.find((k) => k.field === 'providers')!;
    kind.collect(sink, 'p', { id: 'a', factory: (() => ({})) as never });
    expect(sink.providers).toEqual([{ pluginId: 'p', id: 'a', factory: expect.any(Function) }]);
  });
});

describe('registry publish semantics', () => {
  it('cross-plugin key conflict throws and leaves the effective set intact', () => {
    const registry = new PluginContributionRegistry();
    const first = makePlugin('p1', (api) => {
      api.registerTool({ name: 'x', description: '', parameters: {}, capabilities: ['fs-read'] }, (async () => ({})) as never);
    });
    registry.publish([first]);
    expect(registry.getTools().map((tool) => tool.definition.name)).toEqual(['x']);

    const second = makePlugin('p2', (api) => {
      api.registerTool({ name: 'x', description: '', parameters: {}, capabilities: ['fs-read'] }, (async () => ({})) as never);
    });
    expect(() => registry.publish([first, second])).toThrow('Contribution conflict tool:x');
    // Atomic publish: the previous effective set survives the rejected publish.
    expect(registry.getTools().map((tool) => tool.definition.name)).toEqual(['x']);
  });

  it('before_agent_reply allows at most one owner', () => {
    const registry = new PluginContributionRegistry();
    const first = makePlugin('p1', (api) => api.on('before_agent_reply', (() => {}) as never));
    const second = makePlugin('p2', (api) => api.on('before_agent_reply', (() => {}) as never));
    expect(() => registry.publish([first, second])).toThrow('Override hook before_agent_reply has multiple owners: p1, p2');
  });

  it('published hook records keep their registration-time pluginId', () => {
    const registry = new PluginContributionRegistry();
    const plugin = makePlugin('p1', (api) => api.on('agent_end', (() => {}) as never));
    registry.publish([plugin]);
    expect(registry.getHooks().map((hook) => hook.pluginId)).toEqual(['p1']);
    expect(registry.getHooks().map((hook) => hook.hookName)).toEqual(['agent_end']);
  });
});
