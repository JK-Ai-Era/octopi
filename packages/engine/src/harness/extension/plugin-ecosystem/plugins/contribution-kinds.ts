/**
 * Declarative contribution-kind table — the single source of truth for the
 * plugin contribution pipeline semantics: staging uniqueness, reserved ids,
 * publish ownership, manifest claims, manifest uniqueness and manifest↔
 * registration reconciliation.
 *
 * Adding a contribution kind = one descriptor here + the typed surfaces
 * (PluginApi.registerXxx signature, staging slot, record type/getter, manifest
 * schema field). The staging write path (`push`, via `stageContribution`) and
 * the staged-entry read path (`forEachStaged`, which pairs entries with their
 * keys) both live on the descriptor, so the key↔entry pairing and the
 * uniqueness checks cannot be bypassed or forgotten per kind.
 *
 * Hooks are the deliberate semantic exception (multi-handler per name, no
 * cross-plugin ownership), but their staging write path — priority-sorted Map
 * insert — is also owned here (`hooks.push`), not by `PluginApi.on`.
 */

import { BUILTIN_CHANNEL_IDS } from '../channel-types.js';
import type { ContributionInstanceTable } from './contribution-instances.js';
import type {
  OrderedHookEntry,
  PluginChannelRegistration,
  PluginCommandRegistration,
  PluginProviderRegistration,
  PluginToolContribution,
} from './api.js';
import type { HookServiceRegistration } from '../hooks/types.js';
import type { PluginManifest } from './manifest.js';
import type { StagedContributions } from './staging.js';

/** Field name shared by the manifest `contributes` block and the staging slot. */
export type ContributionField = 'tools' | 'commands' | 'hooks' | 'services' | 'providers' | 'channels';

/**
 * Published-record slots. Records are uniformly `{ pluginId, ...entry }`
 * (hooks entries already carry `pluginId`, so they are stored verbatim). The
 * registry's typed getters return these slots; their declared record types are
 * structurally identical, so drift is caught at compile time.
 */
export interface ContributionSink {
  tools: ({ pluginId: string } & PluginToolContribution)[];
  commands: ({ pluginId: string } & PluginCommandRegistration)[];
  hooks: OrderedHookEntry[];
  services: ({ pluginId: string } & HookServiceRegistration)[];
  providers: ({ pluginId: string } & PluginProviderRegistration)[];
  channels: ({ pluginId: string } & PluginChannelRegistration)[];
}

/** Host-private hook that factory-backed records carry (see record.acceptInstance). */
export interface ContributionInstanceHostHook {
  /**
   * Register the Host-accepted instance (birth) with its config identity.
   *
   * @param instance - The accepted factory product
   * @param label - Config identity of this instantiation
   * @returns Whether the instance is retirement-trackable; false means it was
   *   not registered (frozen/sealed) and the Host should surface the
   *   degradation — lookup will report it as never instantiated
   */
  acceptInstance(instance: object, label: string): boolean;
}

export interface ContributionKind<TEntry extends object> {
  /** Manifest `contributes.<field>` / staging slot name. */
  readonly field: ContributionField;
  /**
   * Singular label used in diagnostics and ownership keys ("provider"). The
   * ownership key prefix (`tool:`, `provider:`, …) IS this label — changing it
   * changes conflict identity, so treat labels as stable identifiers.
   */
  readonly label: string;
  /** Whether one key may be owned by only one plugin (hooks chain across plugins). */
  readonly globallyUnique: boolean;
  /** Whether one plugin may stage the same key only once (hooks allow many handlers). */
  readonly perPluginUnique: boolean;
  /** Ids plugins may never claim (built-in adapters). */
  readonly reservedIds: readonly string[];
  /** Unique key of one staged entry. */
  keyOf(entry: TEntry): string;
  /** Keys declared in the manifest `contributes` block (raw, unnormalized). */
  declaredKeys(manifest: PluginManifest): string[];
  /**
   * Iterate staged entries paired with their keys — the read side's single
   * path. The pairing is computed inside the descriptor, so consumers cannot
   * observe a key without its entry or vice versa.
   */
  forEachStaged(slot: StagedContributions, visit: (key: string, entry: TEntry) => void): void;
  /** Stage one entry — the write side's single path (hooks: priority-sorted Map insert). */
  push(slot: StagedContributions, entry: TEntry): void;
  /** Append one published record to the registry sink. */
  collect(sink: ContributionSink, pluginId: string, entry: TEntry): void;
  /**
   * Factory-backed kinds only: extend the staged entry with the host-private
   * `acceptInstance` hook so the Host can register the instance it accepted
   * (birth) and the table can track its retirement. The wiring lives here,
   * like `push`, so a new factory kind cannot silently produce untracked
   * instances — the return type makes the hook mandatory at compile time.
   */
  bindInstances?(entry: TEntry, instances: ContributionInstanceTable): TEntry & ContributionInstanceHostHook;
  /** Kind-specific manifest checks beyond per-kind key uniqueness. */
  assertManifestExtras?(manifest: PluginManifest): void;
  /** Kind-specific manifest↔registration reconciliation beyond key matching. */
  reconcileExtra?(manifest: PluginManifest, slot: StagedContributions): void;
}

const tools: ContributionKind<PluginToolContribution> = {
  field: 'tools',
  label: 'tool',
  globallyUnique: true,
  perPluginUnique: true,
  reservedIds: [],
  keyOf: (entry) => entry.definition.name,
  declaredKeys: (manifest) => manifest.contributes?.tools ?? [],
  forEachStaged: (slot, visit) => {
    for (const entry of slot.tools) visit(entry.definition.name, entry);
  },
  push: (slot, entry) => {
    slot.tools.push(entry);
  },
  collect: (sink, pluginId, entry) => {
    sink.tools.push({ pluginId, ...entry });
  },
};

const commands: ContributionKind<PluginCommandRegistration> = {
  field: 'commands',
  label: 'command',
  globallyUnique: true,
  perPluginUnique: true,
  reservedIds: [],
  keyOf: (entry) => entry.name,
  declaredKeys: (manifest) => (manifest.contributes?.commands ?? []).map((command) => command.name),
  forEachStaged: (slot, visit) => {
    for (const entry of slot.commands) visit(entry.name, entry);
  },
  push: (slot, entry) => {
    slot.commands.push(entry);
  },
  collect: (sink, pluginId, entry) => {
    sink.commands.push({ pluginId, ...entry });
  },
  assertManifestExtras: (manifest) => {
    for (const command of manifest.contributes?.commands ?? []) {
      assertUnique(command.sessionOps ?? [], `contributes.commands.${command.name}.sessionOps`);
    }
  },
  reconcileExtra: (manifest, slot) => {
    const declared = new Map(
      (manifest.contributes?.commands ?? []).map((command) => [command.name, command.sessionOps ?? []]),
    );
    for (const command of slot.commands) {
      const expected = declared.get(command.name) ?? [];
      const actual = command.sessionOps ?? [];
      if (JSON.stringify([...expected].sort()) !== JSON.stringify([...actual].sort())) {
        throw new Error(`Command "${command.name}" sessionOps differ from manifest`);
      }
    }
  },
};

const hooks: ContributionKind<OrderedHookEntry> = {
  field: 'hooks',
  label: 'hook',
  globallyUnique: false,
  perPluginUnique: false,
  reservedIds: [],
  keyOf: (entry) => entry.hookName,
  declaredKeys: (manifest) => manifest.contributes?.hooks ?? [],
  forEachStaged: (slot, visit) => {
    for (const [hookName, entries] of slot.hooks) {
      for (const entry of entries) visit(hookName, entry);
    }
  },
  push: (slot, entry) => {
    const entries = [...(slot.hooks.get(entry.hookName) ?? []), entry];
    entries.sort((a, b) => b.priority - a.priority);
    slot.hooks.set(entry.hookName, entries);
  },
  collect: (sink, _pluginId, entry) => {
    // Invariant: entry.pluginId is stamped with PluginApi.id at registration
    // (api.ts `on`), and publish only ever iterates that plugin's own staging.
    sink.hooks.push(entry);
  },
};

const services: ContributionKind<HookServiceRegistration> = {
  field: 'services',
  label: 'service',
  globallyUnique: true,
  perPluginUnique: true,
  reservedIds: [],
  keyOf: (entry) => entry.serviceId,
  declaredKeys: (manifest) => manifest.contributes?.services ?? [],
  forEachStaged: (slot, visit) => {
    for (const entry of slot.services) visit(entry.serviceId, entry);
  },
  push: (slot, entry) => {
    slot.services.push(entry);
  },
  collect: (sink, pluginId, entry) => {
    sink.services.push({ pluginId, ...entry });
  },
};

const providers: ContributionKind<PluginProviderRegistration> = {
  field: 'providers',
  label: 'provider',
  globallyUnique: true,
  perPluginUnique: true,
  reservedIds: [],
  keyOf: (entry) => entry.id,
  declaredKeys: (manifest) => manifest.contributes?.providers ?? [],
  forEachStaged: (slot, visit) => {
    for (const entry of slot.providers) visit(entry.id, entry);
  },
  push: (slot, entry) => {
    slot.providers.push(entry);
  },
  collect: (sink, pluginId, entry) => {
    sink.providers.push({ pluginId, ...entry });
  },
  bindInstances: (entry, instances) => ({
    ...entry,
    // The Host calls acceptInstance after validating the factory product
    // (config.ts::createProviderFromConfig) — birth means Host acceptance.
    acceptInstance: (instance, label) =>
      instances.attach({
        kind: 'provider',
        key: entry.id,
        label,
        instance,
        retireMethod: 'dispose',
        // dispose is optional on ModelProvider — define it as a retirement
        // marker so Host teardown always retires the registry entry.
        defineRetire: true,
      }),
  }),
};

const channels: ContributionKind<PluginChannelRegistration> = {
  field: 'channels',
  label: 'channel',
  globallyUnique: true,
  perPluginUnique: true,
  reservedIds: BUILTIN_CHANNEL_IDS,
  keyOf: (entry) => entry.id,
  declaredKeys: (manifest) => manifest.contributes?.channels ?? [],
  forEachStaged: (slot, visit) => {
    for (const entry of slot.channels) visit(entry.id, entry);
  },
  push: (slot, entry) => {
    slot.channels.push(entry);
  },
  collect: (sink, pluginId, entry) => {
    sink.channels.push({ pluginId, ...entry });
  },
  bindInstances: (entry, instances) => ({
    ...entry,
    // The Host calls acceptInstance after validating the factory product
    // (config.ts::createChannelAdapterFromConfig) — birth means Host acceptance.
    acceptInstance: (instance, label) =>
      instances.attach({
        kind: 'channel',
        key: entry.id,
        label,
        instance,
        retireMethod: 'stop',
        // stop is mandatory on ChannelAdapter — never add it here, or the
        // Host's contract validation would stop reporting broken adapters.
        defineRetire: false,
      }),
  }),
};

/**
 * Every contribution kind in manifest-schema order. Iteration order is
 * observable in first-failure diagnostics and record ordering — keep it aligned
 * with the `contributes` schema field order.
 */
export const CONTRIBUTION_KINDS: readonly ContributionKind<object>[] = [
  tools,
  commands,
  hooks,
  services,
  providers,
  channels,
];

/** Typed staging slots for the author-facing register methods. */
export const TOOL_KIND = tools;
export const COMMAND_KIND = commands;
export const HOOK_KIND = hooks;
export const SERVICE_KIND = services;
export const PROVIDER_KIND = providers;
export const CHANNEL_KIND = channels;

function capitalize(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Reject a manifest key list containing duplicates.
 *
 * @param values - Declared contribution keys
 * @param field - Manifest field path for the error message
 */
export function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Plugin manifest ${field} contains duplicate entries`);
  }
}

/**
 * Enforce per-kind key uniqueness of the manifest `contributes` block, plus
 * kind-specific manifest checks.
 *
 * @param manifest - Plugin manifest
 * @throws Error naming the first duplicated key
 */
export function assertManifestKeysUnique(manifest: PluginManifest): void {
  for (const kind of CONTRIBUTION_KINDS) {
    assertUnique(kind.declaredKeys(manifest), `contributes.${kind.field}`);
    kind.assertManifestExtras?.(manifest);
  }
}

/**
 * Reject a contribution key a plugin may never claim (built-in adapters).
 *
 * @param pluginId - Staging plugin
 * @param kind - Contribution kind being staged
 * @param key - Normalized contribution key
 */
export function assertClaimable(pluginId: string, kind: ContributionKind<object>, key: string): void {
  if (kind.reservedIds.includes(key)) {
    throw new Error(`Plugin "${pluginId}" cannot register ${kind.label} "${key}": reserved by built-in adapters`);
  }
}

/**
 * Reject a duplicate key staged twice by one plugin.
 *
 * @param pluginId - Staging plugin
 * @param kind - Contribution kind being staged
 * @param slot - The plugin's staging area
 * @param key - Normalized contribution key
 */
export function assertStagingKeyFree(
  pluginId: string,
  kind: ContributionKind<object>,
  slot: StagedContributions,
  key: string,
): void {
  if (!kind.perPluginUnique) return;
  let duplicate = false;
  kind.forEachStaged(slot, (stagedKey) => {
    if (stagedKey === key) duplicate = true;
  });
  if (duplicate) {
    throw new Error(`Plugin "${pluginId}" registered duplicate ${kind.label} "${key}"`);
  }
}

/**
 * The staging write path shared by every register method: reserved-id and
 * per-plugin uniqueness checks, then the kind's own staging insert.
 *
 * @param pluginId - Staging plugin
 * @param kind - Contribution kind being staged
 * @param slot - The plugin's staging area
 * @param entry - Contribution entry to stage
 */
export function stageContribution<TEntry extends object>(
  pluginId: string,
  kind: ContributionKind<TEntry>,
  slot: StagedContributions,
  entry: TEntry,
): void {
  const key = kind.keyOf(entry);
  assertClaimable(pluginId, kind, key);
  assertStagingKeyFree(pluginId, kind, slot, key);
  kind.push(slot, entry);
}

/**
 * Manifest-side ownership claim strings ("provider:openai-compat") used by the
 * loader's cross-plugin conflict detection. Kinds without cross-plugin
 * ownership (hooks) declare no claims.
 *
 * @param kind - Contribution kind
 * @param manifest - Candidate manifest
 * @returns Claim strings for every declared key of the kind
 */
export function declaredClaims(kind: ContributionKind<object>, manifest: PluginManifest): string[] {
  if (!kind.globallyUnique) return [];
  return kind.declaredKeys(manifest).map((key) => `${kind.label}:${key}`);
}

/**
 * Reconcile the manifest `contributes` block against what the plugin actually
 * staged: both directions must match exactly, then kind-specific checks run.
 *
 * @param kind - Contribution kind
 * @param manifest - Plugin manifest
 * @param slot - The plugin's staging area
 * @throws Error naming the first mismatched key
 */
export function assertManifestCoverage(
  kind: ContributionKind<object>,
  manifest: PluginManifest,
  slot: StagedContributions,
): void {
  const declared = new Set(kind.declaredKeys(manifest));
  const actual = new Set<string>();
  kind.forEachStaged(slot, (key) => actual.add(key));
  for (const key of actual) {
    if (!declared.has(key)) throw new Error(`${capitalize(kind.label)} "${key}" is not declared in manifest`);
  }
  for (const key of declared) {
    if (!actual.has(key)) throw new Error(`Declared ${kind.label} "${key}" was not registered`);
  }
  kind.reconcileExtra?.(manifest, slot);
}
