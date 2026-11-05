/** Manifest-first discovery: no plugin code runs before eligibility and config validation. */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PluginApi } from './api.js';
import {
  parseManifest,
  validatePluginConfig,
  type PluginManifest,
} from './manifest.js';
import type { OctopiPluginDefinition } from './entry.js';
import {
  PluginContributionRegistry,
  type RegisteredPlugin,
} from './contribution-registry.js';
import { getEngineVersion, satisfiesEngineRange } from './engine-compatibility.js';
import { readStaging } from './staging.js';

export interface PluginEntryConfig {
  enabled?: boolean;
  config?: Record<string, unknown>;
  /** Per-plugin hook timeout policy; consumed by the Hook adapter (timeouts keyed by hook name). */
  hooks?: {
    timeoutMs?: number;
    timeouts?: Record<string, number>;
  };
}

export interface PluginLoaderConfig {
  loadPaths: string[];
  allowList?: string[];
  blockList?: string[];
  entries?: Record<string, PluginEntryConfig>;
  engineVersion?: string;
}

export type PluginDiagnosticStatus = 'disabled' | 'failed' | 'registered';

export interface PluginDiagnostic {
  id: string;
  status: PluginDiagnosticStatus;
  stage: 'manifest' | 'policy' | 'dependency' | 'config' | 'entry' | 'import' | 'register' | 'publish';
  reason: string;
  path?: string;
}

export interface LoadedPlugin extends RegisteredPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  manifest: PluginManifest;
  definition: OctopiPluginDefinition;
  source: 'local' | 'npm';
  registered: true;
}

interface Candidate {
  id: string;
  rootDir: string;
  manifest: PluginManifest;
  config?: PluginEntryConfig;
  eligible: boolean;
  rejected: boolean;
  entryPoint?: string;
  pluginConfig?: Record<string, unknown>;
}

const PLUGIN_MANIFEST_FILENAME = 'octopi.plugin.json';

export class PluginLoader {
  readonly contributions = new PluginContributionRegistry();
  private config: PluginLoaderConfig;
  private plugins = new Map<string, LoadedPlugin>();
  private diagnostics: PluginDiagnostic[] = [];

  constructor(config: PluginLoaderConfig) {
    this.config = config;
  }

  /** Resolve a loaded plugin's configured hook policy, including legacy aliases. */
  getPluginConfig(id: string): PluginEntryConfig | undefined {
    const plugin = this.plugins.get(id);
    if (!plugin) return undefined;
    const ids = [plugin.id, ...(plugin.manifest.legacyPluginIds ?? [])];
    return ids.map((key) => this.config.entries?.[key]).find((entry) => entry !== undefined);
  }

  /** Discover, validate and atomically publish the successful plugin set. */
  async discover(): Promise<LoadedPlugin[]> {
    // Keep the previous effective snapshot until the next complete set validates.
    this.diagnostics = [];
    const candidates = new Map<string, Candidate>();
    const aliases = new Map<string, string>();
    const rejectedIds = new Set<string>();
    for (const loadPath of this.config.loadPaths) {
      for (const rootDir of this.scanDirectories(loadPath)) {
        const candidate = this.readCandidate(rootDir);
        if (candidate) this.addCandidate(candidate, candidates, aliases, rejectedIds);
      }
    }
    for (const candidate of candidates.values()) {
      candidate.config = this.config.entries?.[candidate.id];
    }
    for (const id of rejectedIds) {
      const candidate = candidates.get(id);
      if (candidate) candidate.rejected = true;
    }
    this.applyAliases(candidates);
    for (const candidate of candidates.values()) {
      candidate.eligible = this.isEligible(candidate);
    }
    for (const candidate of candidates.values()) {
      if (candidate.eligible) this.prepareCandidate(candidate);
    }
    // Configuration, entry, conflict and dependency failures must settle before any import.
    let changed = true;
    while (changed) {
      const before = [...candidates.values()].filter((candidate) => candidate.eligible).length;
      this.markDependencyFailures(candidates, aliases);
      this.checkDeclaredConflicts(candidates);
      changed = before !== [...candidates.values()].filter((candidate) => candidate.eligible).length;
    }

    const staged: RegisteredPlugin[] = [];
    for (const candidate of candidates.values()) {
      if (!candidate.eligible) continue;
      const plugin = await this.importAndRegister(candidate);
      if (plugin) staged.push(plugin);
      else candidate.eligible = false;
    }
    this.markDependencyFailures(candidates, aliases);
    const publishable = staged.filter((plugin) => candidates.get(plugin.manifest.id)?.eligible);
    for (const plugin of staged) {
      if (!candidates.get(plugin.manifest.id)?.eligible) {
        this.fail(plugin.manifest.id, 'dependency', new Error('A required plugin failed to register'), plugin.path);
      }
    }

    const nextDiscoveryFailed = this.diagnostics.some((item) => item.status === 'failed');
    if (publishable.length === 0 && nextDiscoveryFailed && this.plugins.size > 0) {
      const reason = 'New discovery has no publishable plugins; last complete snapshot retained for diagnosis';
      this.fail('discovery', 'publish', new Error(reason));
      throw new Error(`Plugin discovery failed: ${reason}`);
    }
    try {
      const nextPlugins = new Map<string, LoadedPlugin>();
      for (const plugin of publishable) {
        const loaded: LoadedPlugin = {
          ...plugin,
          id: plugin.manifest.id,
          name: plugin.manifest.name,
          version: plugin.manifest.version,
          ...(plugin.manifest.description === undefined ? {} : { description: plugin.manifest.description }),
          source: 'local',
          registered: true,
        };
        nextPlugins.set(loaded.id, loaded);
      }
      this.contributions.publish(publishable);
      this.plugins = nextPlugins;
      for (const plugin of nextPlugins.values()) {
        this.diagnostics.push({ id: plugin.id, status: 'registered', stage: 'publish', reason: 'registered', path: plugin.path });
      }
    } catch (error) {
      // publish constructs a replacement set before assignment; a conflict cannot leave a partial new set.
      this.fail('unknown', 'publish', error);
    }
    return this.getRegisteredIds().map((id) => this.plugins.get(id)!);
  }

  private scanDirectories(loadPath: string): string[] {
    const root = resolve(loadPath);
    try {
      const stat = readdirSync(root, { withFileTypes: true });
      if (existsSync(join(root, PLUGIN_MANIFEST_FILENAME))) return [root];
      return stat
        .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, PLUGIN_MANIFEST_FILENAME)))
        .map((entry) => join(root, entry.name));
    } catch (error) {
      this.diagnostics.push({ id: root, status: 'failed', stage: 'manifest', reason: errorMessage(error), path: root });
      return [];
    }
  }

  private readCandidate(rootDir: string): Candidate | null {
    try {
      const manifest = parseManifest(readFileSync(join(rootDir, PLUGIN_MANIFEST_FILENAME), 'utf8'));
      return { id: manifest.id, rootDir, manifest, eligible: false, rejected: false };
    } catch (error) {
      this.fail(rootDir, 'manifest', error, rootDir);
      return null;
    }
  }

  private addCandidate(
    candidate: Candidate,
    candidates: Map<string, Candidate>,
    aliases: Map<string, string>,
    rejectedIds: Set<string>,
  ): void {
    const previous = candidates.get(candidate.id);
    if (previous) {
      this.fail(candidate.id, 'manifest', new Error(`Duplicate plugin id at ${candidate.rootDir} and ${previous.rootDir}`), candidate.rootDir);
      rejectedIds.add(candidate.id);
      return;
    }
    const ids = [candidate.id, ...(candidate.manifest.legacyPluginIds ?? [])];
    for (const id of ids) {
      const owner = aliases.get(id);
      if (owner && owner !== candidate.id) {
        this.fail(candidate.id, 'manifest', new Error(`Plugin id or legacy alias "${id}" conflicts with "${owner}"`), candidate.rootDir);
        this.fail(owner, 'manifest', new Error(`Plugin id or legacy alias "${id}" conflicts with "${candidate.id}"`));
        rejectedIds.add(candidate.id).add(owner);
      }
    }
    for (const id of ids) aliases.set(id, candidate.id);
    candidates.set(candidate.id, candidate);
  }

  private applyAliases(candidates: Map<string, Candidate>): void {
    for (const candidate of candidates.values()) {
      const spellings = [candidate.id, ...(candidate.manifest.legacyPluginIds ?? [])];
      const configured = spellings.filter((id) => this.config.entries?.[id] !== undefined);
      if (configured.length > 1) {
        this.fail(candidate.id, 'policy', new Error(`Plugin is configured under multiple identities: ${configured.join(', ')}`), candidate.rootDir);
        candidate.rejected = true;
      } else if (configured.length === 1) {
        candidate.config = this.config.entries?.[configured[0]!];
      }
    }
  }

  private isEligible(candidate: Candidate): boolean {
    if (candidate.rejected) return false;
    const ids = [candidate.id, ...(candidate.manifest.legacyPluginIds ?? [])];
    if (this.config.blockList?.some((id) => ids.includes(id))) {
      this.disabled(candidate, 'blocklisted');
      return false;
    }
    if (this.config.allowList && !ids.some((id) => this.config.allowList!.includes(id))) {
      this.disabled(candidate, 'not in allowList');
      return false;
    }
    const enabled = candidate.config?.enabled ?? candidate.manifest.enabledByDefault ?? true;
    if (!enabled) {
      this.disabled(candidate, 'disabled by configuration or manifest default');
      return false;
    }
    return true;
  }

  private prepareCandidate(candidate: Candidate): void {
    try {
      candidate.entryPoint = this.resolveEntry(candidate.rootDir, candidate.manifest.entry);
      candidate.pluginConfig = validatePluginConfig(candidate.manifest, candidate.config?.config);
      const engineVersion = this.config.engineVersion ?? getEngineVersion();
      if (!satisfiesEngineRange(engineVersion, candidate.manifest.engine.octopi)) {
        throw new Error(`Requires Octopi ${candidate.manifest.engine.octopi}; host is ${engineVersion}`);
      }
    } catch (error) {
      this.fail(candidate.id, 'config', error, candidate.rootDir);
      candidate.eligible = false;
    }
  }

  private markDependencyFailures(candidates: Map<string, Candidate>, aliases: Map<string, string>): void {
    const visiting = new Set<string>();
    const failed = new Set<string>();
    const visit = (id: string): boolean => {
      const candidate = candidates.get(id);
      if (!candidate || !candidate.eligible) return false;
      if (visiting.has(id)) {
        this.fail(id, 'dependency', new Error('Circular plugin dependency'), candidate.rootDir);
        candidate.eligible = false;
        failed.add(id);
        return false;
      }
      if (failed.has(id)) return false;
      visiting.add(id);
      for (const dependencyName of candidate.manifest.requiresPlugins ?? []) {
        const dependency = aliases.get(dependencyName) ?? dependencyName;
        if (!visit(dependency)) {
          this.fail(id, 'dependency', new Error(`Missing or ineligible dependency "${dependencyName}" (resolved to "${dependency}")`), candidate.rootDir);
          candidate.eligible = false;
          failed.add(id);
          break;
        }
      }
      visiting.delete(id);
      return candidate.eligible;
    };
    for (const id of candidates.keys()) visit(id);
  }

  private checkDeclaredConflicts(candidates: Map<string, Candidate>): void {
    const claims = new Map<string, string>();
    for (const candidate of candidates.values()) {
      if (!candidate.eligible) continue;
      const entries = [
        ...(candidate.manifest.contributes?.tools ?? []).map((name) => `tool:${name}`),
        ...(candidate.manifest.contributes?.commands ?? []).map((command) => `command:${command.name}`),
        ...(candidate.manifest.contributes?.services ?? []).map((name) => `service:${name}`),
      ];
      for (const claim of entries) {
        const owner = claims.get(claim);
        if (owner) {
          this.fail(candidate.id, 'register', new Error(`Declared ${claim} conflicts with "${owner}"`), candidate.rootDir);
          candidate.eligible = false;
          const first = candidates.get(owner);
          if (first) {
            first.eligible = false;
            this.fail(owner, 'register', new Error(`Declared ${claim} conflicts with "${candidate.id}"`), first.rootDir);
          }
        } else claims.set(claim, candidate.id);
      }
    }
  }

  private async importAndRegister(candidate: Candidate): Promise<RegisteredPlugin | null> {
    const { manifest, rootDir, entryPoint, pluginConfig } = candidate;
    if (!entryPoint || !pluginConfig) {
      this.fail(manifest.id, 'config', new Error('Candidate has not completed pre-import validation'), rootDir);
      return null;
    }
    try {
      const module = await import(pathToFileURL(entryPoint).href);
      const definition = module.default as OctopiPluginDefinition | undefined;
      if (!definition || definition.id !== manifest.id || typeof definition.register !== 'function') {
        throw new Error(`Default entry must be definePlugin({ id: "${manifest.id}", register })`);
      }
      const api = new PluginApi({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        ...(manifest.description === undefined ? {} : { description: manifest.description }),
        source: rootDir,
        rootDir,
        pluginConfig,
      });
      await definition.register(api);
      this.assertActualContributions(manifest, api);
      return { manifest, definition, api, path: rootDir };
    } catch (error) {
      this.fail(manifest.id, 'register', error, rootDir);
      return null;
    }
  }

  private resolveEntry(rootDir: string, entry: string): string {
    const root = realpathSync(rootDir);
    const candidate = resolve(root, entry);
    if (relative(root, candidate).startsWith(`..${sep}`) || relative(root, candidate) === '..') {
      throw new Error(`Plugin entry escapes its root: ${entry}`);
    }
    const real = realpathSync(candidate);
    const rel = relative(root, real);
    if (rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error(`Plugin entry realpath escapes its root: ${entry}`);
    }
    return real;
  }

  private assertActualContributions(manifest: PluginManifest, api: PluginApi): void {
    const staged = readStaging(api);
    const declaredTools = new Set(manifest.contributes?.tools ?? []);
    const actualTools = new Set(staged.tools.map((tool) => tool.definition.name));
    const declaredCommands = new Map((manifest.contributes?.commands ?? []).map((command) => [command.name, command.sessionOps ?? []]));
    for (const tool of actualTools) {
      if (!declaredTools.has(tool)) throw new Error(`Tool "${tool}" is not declared in manifest`);
    }
    for (const tool of declaredTools) {
      if (!actualTools.has(tool)) throw new Error(`Declared tool "${tool}" was not registered`);
    }
    const actualCommands = new Set(staged.commands.map((command) => command.name));
    for (const command of actualCommands) {
      if (!declaredCommands.has(command)) throw new Error(`Command "${command}" is not declared in manifest`);
    }
    for (const command of declaredCommands.keys()) {
      if (!actualCommands.has(command)) throw new Error(`Declared command "${command}" was not registered`);
    }
    for (const command of staged.commands) {
      const declared = declaredCommands.get(command.name) ?? [];
      const actual = command.sessionOps ?? [];
      if (JSON.stringify([...declared].sort()) !== JSON.stringify([...actual].sort())) {
        throw new Error(`Command "${command.name}" sessionOps differ from manifest`);
      }
    }
    const declaredHooks = new Set(manifest.contributes?.hooks ?? []);
    for (const hook of staged.hooks.keys()) {
      if (!declaredHooks.has(hook)) throw new Error(`Hook "${hook}" is not declared in manifest`);
    }
    for (const hook of declaredHooks) {
      if (!staged.hooks.has(hook)) throw new Error(`Declared hook "${hook}" was not registered`);
    }
    const declaredServices = new Set(manifest.contributes?.services ?? []);
    const actualServices = new Set(staged.services.map((service) => service.serviceId));
    for (const service of actualServices) {
      if (!declaredServices.has(service)) throw new Error(`Service "${service}" is not declared in manifest`);
    }
    for (const service of declaredServices) {
      if (!actualServices.has(service)) throw new Error(`Declared service "${service}" was not registered`);
    }
  }

  private disabled(candidate: Candidate, reason: string): void {
    this.diagnostics.push({ id: candidate.id, status: 'disabled', stage: 'policy', reason, path: candidate.rootDir });
  }

  private fail(id: string, stage: PluginDiagnostic['stage'], error: unknown, path?: string): void {
    this.diagnostics.push({ id, status: 'failed', stage, reason: errorMessage(error), ...(path === undefined ? {} : { path }) });
  }

  getDiagnostics(): PluginDiagnostic[] { return this.diagnostics.map((item) => ({ ...item })); }
  getRegisteredIds(): string[] { return [...this.plugins.keys()]; }
  getPlugin(id: string): LoadedPlugin | undefined { return this.plugins.get(id); }
  getAllPlugins(): LoadedPlugin[] { return [...this.plugins.values()]; }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
