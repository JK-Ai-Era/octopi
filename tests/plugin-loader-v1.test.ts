import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginLoader, type PluginLoaderConfig } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/loader.js';
import { PluginManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/manager.js';

let root: string;
let sideEffect: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'octopi-plugin-v1-'));
  sideEffect = join(root, 'executed.jsonl');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

interface FixtureOptions {
  id?: string;
  enabledByDefault?: boolean;
  configSchema?: Record<string, unknown>;
  tools?: string[];
  commands?: Array<{ name: string; sessionOps?: string[] }>;
  hooks?: string[];
  requiresPlugins?: string[];
  legacyPluginIds?: string[];
  body?: string;
  entry?: string;
  engine?: string;
}

function plugin(directory: string, options: FixtureOptions = {}): void {
  const id = options.id ?? directory;
  const dir = join(root, directory);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    apiVersion: '1',
    version: '1.0.0',
    name: id,
    entry: options.entry ?? './index.mjs',
    enabledByDefault: options.enabledByDefault,
    engine: { octopi: options.engine ?? '>=0.1.0' },
    configSchema: options.configSchema ?? { type: 'object', additionalProperties: true },
    contributes: {
      tools: options.tools,
      commands: options.commands,
      hooks: options.hooks,
    },
    requiresPlugins: options.requiresPlugins,
    legacyPluginIds: options.legacyPluginIds,
  };
  writeFileSync(join(dir, 'octopi.plugin.json'), JSON.stringify(manifest));
  const body = options.body ?? `api.registerTool({ name: 'echo', description: 'Echo', parameters: {}, capabilities: ['egress'] }, async () => 'ok');`;
  writeFileSync(join(dir, 'index.mjs'), `
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(sideEffect)}, ${JSON.stringify(`${id}:import\n`)});
    export default { id: ${JSON.stringify(id)}, register(api) {
      appendFileSync(${JSON.stringify(sideEffect)}, ${JSON.stringify(`${id}:register\n`)});
      ${body}
    } };
  `);
}

function effects(): string[] {
  try { return readFileSync(sideEffect, 'utf8').trim().split('\n').filter(Boolean); }
  catch { return []; }
}

function config(id: string, config: Record<string, unknown> = {}): PluginLoaderConfig {
  return { loadPaths: [root], engineVersion: '0.98.18', entries: { [id]: { config } } };
}

describe('PluginLoader v1 manifest-first behavior', () => {
  it('does not import disabled, blocked, non-allowed or invalid-config entries', async () => {
    plugin('disabled');
    plugin('blocked');
    plugin('not-allowed');
    plugin('invalid', { configSchema: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] } });
    const loader = new PluginLoader({
      loadPaths: [root],
      engineVersion: '0.98.18',
      allowList: ['disabled', 'blocked', 'invalid'],
      blockList: ['blocked'],
      entries: { disabled: { enabled: false }, invalid: { config: { region: 42 } } },
    });
    expect(await loader.discover()).toEqual([]);
    expect(effects()).toEqual([]);
    expect(Object.fromEntries(loader.getDiagnostics().map((item) => [item.id, item.status]))).toEqual({
      disabled: 'disabled', blocked: 'disabled', 'not-allowed': 'disabled', invalid: 'failed',
    });
  });

  it('validates config before import and passes the validated object to the author API', async () => {
    plugin('configured', {
      configSchema: { type: 'object', properties: { region: { type: 'string', enum: ['cn'] } }, required: ['region'], additionalProperties: false },
      body: `appendFileSync(${JSON.stringify(sideEffect)}, JSON.stringify(api.pluginConfig) + '\\n');`,
    });
    const loader = new PluginLoader(config('configured', { region: 'cn' }));
    const loaded = await loader.discover();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.api.pluginConfig).toEqual({ region: 'cn' });
    expect(loaded[0]!.api.resolvePath('data.json')).toBe(join(root, 'configured', 'data.json'));
  });

  it('publishes Tool, Command and Hook only after every contribution matches the manifest', async () => {
    plugin('complete', {
      tools: ['echo'], commands: [{ name: 'echo', sessionOps: ['new_session'] }], hooks: ['message_received'],
      body: `
        api.registerTool({ name: 'echo', description: 'Echo', parameters: {}, capabilities: ['egress'] }, async () => 'ok');
        api.registerCommand({ name: 'echo', sessionOps: ['new_session'], handler: async () => 'ok' });
        api.on('message_received', async () => {});
      `,
    });
    const manager = new PluginManager({ loadPaths: [root], engineVersion: '0.98.18' });
    expect(await manager.discover()).toHaveLength(1);
    expect(manager.getTools().map((tool) => tool.pluginId)).toEqual(['complete']);
    expect(manager.getCommands().map((command) => command.pluginId)).toEqual(['complete']);
    await manager.runAllHooks('message_received', {});
    expect(effects()).toEqual(['complete:import', 'complete:register']);
  });

  it('does not retain a partially registered tool or hook after register fails', async () => {
    plugin('broken', {
      tools: ['echo'], hooks: ['message_received'],
      body: `
        api.registerTool({ name: 'echo', description: 'Echo', parameters: {}, capabilities: ['egress'] }, async () => 'ok');
        api.on('message_received', async () => {});
        throw new Error('registration exploded');
      `,
    });
    const manager = new PluginManager({ loadPaths: [root], engineVersion: '0.98.18' });
    expect(await manager.discover()).toEqual([]);
    expect(manager.getTools()).toEqual([]);
    await manager.runAllHooks('message_received', {});
    expect(manager.getDiagnostics()[0]?.status).toBe('failed');
  });

  it('settles config, entry, engine and conflict failures before importing any dependent', async () => {
    plugin('base', { configSchema: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] } });
    plugin('needs-base', { requiresPlugins: ['base'] });
    plugin('one', { tools: ['echo'] });
    plugin('two', { tools: ['echo'] });
    plugin('needs-one', { requiresPlugins: ['one'] });
    plugin('old-engine', { engine: '>=99' });
    plugin('needs-old-engine', { requiresPlugins: ['old-engine'] });
    const loader = new PluginLoader({ loadPaths: [root], engineVersion: '0.98.18' });
    expect(await loader.discover()).toEqual([]);
    expect(effects()).toEqual([]);
  });

  it('resolves legacy dependency IDs and does not expose mutable staging arrays on the author API', async () => {
    plugin('new-id', { legacyPluginIds: ['old-id'], body: '' });
    plugin('consumer', {
      requiresPlugins: ['old-id'],
      body: `if ('_tools' in api || '_hooks' in api || '_commands' in api) throw new Error('staging leaked');`,
    });
    const loader = new PluginLoader({ loadPaths: [root], engineVersion: '0.98.18' });
    expect((await loader.discover()).map((plugin) => plugin.id).sort()).toEqual(['consumer', 'new-id']);
  });

  it('rejects missing dependencies, ineligible dependencies and cycles without loading unrelated plugins', async () => {
    plugin('base', { enabledByDefault: false });
    plugin('needs-base', { requiresPlugins: ['base'] });
    plugin('missing', { requiresPlugins: ['absent'] });
    plugin('cycle-a', { requiresPlugins: ['cycle-b'] });
    plugin('cycle-b', { requiresPlugins: ['cycle-a'] });
    const loader = new PluginLoader({ loadPaths: [root], engineVersion: '0.98.18' });
    expect(await loader.discover()).toEqual([]);
    expect(effects()).toEqual([]);
    expect(loader.getDiagnostics().filter((item) => item.stage === 'dependency').length).toBeGreaterThanOrEqual(4);
  });

  it('rejects dependents of a failed plugin and both sides of a declared conflict', async () => {
    plugin('broken', { tools: ['echo'], body: `throw new Error('broken');` });
    plugin('dependent', { requiresPlugins: ['broken'], body: '' });
    const dependencyLoader = new PluginLoader({ loadPaths: [root], engineVersion: '0.98.18' });
    expect(await dependencyLoader.discover()).toEqual([]);
    expect(dependencyLoader.getDiagnostics().some((item) => item.id === 'dependent' && item.stage === 'dependency')).toBe(true);

    rmSync(join(root, 'broken'), { recursive: true, force: true });
    rmSync(join(root, 'dependent'), { recursive: true, force: true });
    rmSync(sideEffect, { force: true });
    plugin('one', { id: 'one', tools: ['echo'] });
    plugin('two', { id: 'two', tools: ['echo'] });
    const conflictLoader = new PluginLoader({ loadPaths: [root], engineVersion: '0.98.18' });
    expect(await conflictLoader.discover()).toEqual([]);
    expect(effects()).toEqual([]);
    expect(conflictLoader.getDiagnostics().filter((item) => item.reason.includes('Declared tool:echo'))).toHaveLength(2);
  });

  it('resolves legacy configuration to the canonical plugin before policy and rejects dual configuration', async () => {
    plugin('new-id', { legacyPluginIds: ['old-id'] });
    const loader = new PluginLoader({ loadPaths: [root], engineVersion: '0.98.18', entries: { 'old-id': { enabled: false } } });
    expect(await loader.discover()).toEqual([]);
    expect(effects()).toEqual([]);
    const conflict = new PluginLoader({ loadPaths: [root], engineVersion: '0.98.18', entries: { 'old-id': {}, 'new-id': {} } });
    await conflict.discover();
    expect(effects()).toEqual([]);
    expect(conflict.getDiagnostics().some((item) => item.reason.includes('multiple identities'))).toBe(true);
  });

  it('applies legacy IDs to allow/block and rejects conflicting aliases in either direction', async () => {
    plugin('first', { id: 'first', legacyPluginIds: ['shared'], body: '' });
    plugin('second', { id: 'shared', body: '' });
    const loader = new PluginLoader({ loadPaths: [root], engineVersion: '0.98.18', blockList: ['shared'] });
    expect(await loader.discover()).toEqual([]);
    expect(effects()).toEqual([]);
    expect(loader.getDiagnostics().filter((item) => item.reason.includes('legacy alias'))).toHaveLength(2);
  });

  it('keeps the last complete snapshot when a later discovery fails to publish', async () => {
    plugin('valid', { tools: ['echo'] });
    const manager = new PluginManager({ loadPaths: [root], engineVersion: '0.98.18' });
    await manager.discover();
    expect(manager.getPlugin('valid')).toBeDefined();
    expect(manager.getTools()).toHaveLength(1);
    plugin('other', { tools: ['echo'] });
    await expect(manager.discover()).rejects.toThrow('last complete snapshot retained');
    expect(manager.getPlugin('valid')).toBeDefined();
    expect(manager.getTools().map((tool) => tool.pluginId)).toEqual(['valid']);
  });

  it('rejects unknown ToolCapability instead of registering an unenforceable label', async () => {
    plugin('unknown-capability', {
      tools: ['echo'],
      body: `api.registerTool({ name: 'echo', description: 'Echo', parameters: {}, capabilities: ['custom'] }, async () => 'ok');`,
    });
    const loader = new PluginLoader({ loadPaths: [root], engineVersion: '0.98.18' });
    expect(await loader.discover()).toEqual([]);
    expect(loader.contributions.getTools()).toEqual([]);
    expect(loader.getDiagnostics()[0]?.reason).toContain('unknown or duplicate capabilities');
  });

  it('rejects client Commands at registration and discards all staged contributions', async () => {
    plugin('client-command', {
      tools: ['echo'], commands: [{ name: 'local' }],
      body: `
        api.registerTool({ name: 'echo', description: 'Echo', parameters: {}, capabilities: ['egress'] }, async () => 'ok');
        api.registerCommand({ name: 'local', kind: 'client', handler: async () => 'ok' });
      `,
    });
    const loader = new PluginLoader({ loadPaths: [root], engineVersion: '0.98.18' });
    expect(await loader.discover()).toEqual([]);
    expect(loader.contributions.getTools()).toEqual([]);
    expect(loader.contributions.getCommands()).toEqual([]);
    expect(loader.getDiagnostics()[0]?.reason).toContain('unsupported kind');
  });

  it('rejects duplicate ids, undeclared capabilities and incompatible engine ranges', async () => {
    plugin('one', { id: 'duplicate' });
    plugin('two', { id: 'duplicate' });
    plugin('wrong-version', { engine: '>=99' });
    plugin('undeclared');
    const loader = new PluginLoader({ loadPaths: [root], engineVersion: '0.98.18' });
    expect(await loader.discover()).toEqual([]);
    expect(effects()).toEqual(['undeclared:import', 'undeclared:register']);
    expect(loader.getDiagnostics().some((item) => item.reason.includes('Duplicate plugin id'))).toBe(true);
    expect(loader.getDiagnostics().some((item) => item.reason.includes('not declared'))).toBe(true);
    expect(loader.getDiagnostics().some((item) => item.reason.includes('Requires Octopi'))).toBe(true);
  });

  it('rejects an entry whose realpath escapes the plugin root before import', async () => {
    const external = join(root, 'external.mjs');
    writeFileSync(external, `throw new Error('must not execute');`);
    plugin('escape', { entry: './link.mjs' });
    symlinkSync(external, join(root, 'escape', 'link.mjs'));
    const loader = new PluginLoader({ loadPaths: [root], engineVersion: '0.98.18' });
    expect(await loader.discover()).toEqual([]);
    expect(effects()).toEqual([]);
    expect(loader.getDiagnostics()[0]?.reason).toContain('realpath escapes');
  });
});
