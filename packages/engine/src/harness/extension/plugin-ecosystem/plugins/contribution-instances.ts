/**
 * Host-owned contribution instance tracking for factory-backed kinds
 * (providers, channels). Not exported through the author SDK; authors reach it
 * only through `PluginApi.getContributionInstance`.
 *
 * Lifecycle model: an instance is born when the Host **accepts** the factory
 * product (post-validation, i.e. exactly what the Host routes to) and dies by
 * one of two triggers:
 * - physical: the Host calls its lifecycle method (`stop()` for channels,
 *   `dispose()` for providers) — recorded when the call is *requested*,
 *   regardless of outcome, because the Host will not revive it either way;
 * - logical: a newer instance is accepted for the same contribution key and
 *   label (config hot-reload replace). The superseded instance may still serve
 *   draining in-flight work; it is simply no longer returned by lookup.
 *
 * Storage follows the staging pattern: one table per PluginApi, created by the
 * host loader, so a plugin can only ever see instances of its own
 * contributions.
 */

import type { PluginApi } from './api.js';

/** Contribution kinds whose entries are factories producing runtime instances. */
export type ContributionInstanceKind = 'provider' | 'channel';

/** The instance method the Host calls to retire the instance. */
export type RetirementMethod = 'stop' | 'dispose';

export interface ContributionInstanceEntry {
  readonly kind: ContributionInstanceKind;
  /** The contribution key (provider/channel id). */
  readonly key: string;
  /** Config identity of this instantiation (provider config key; channel label). */
  label: string;
  readonly instance: object;
  state: 'live' | 'retired';
  /** Entries this acceptance superseded — restored when the acceptance is rolled back. */
  superseded: ContributionInstanceEntry[];
}

const tables = new WeakMap<PluginApi, ContributionInstanceTable>();

/** Called only by the host when constructing an author API. */
export function createInstanceTable(api: PluginApi): ContributionInstanceTable {
  const table = new ContributionInstanceTable();
  tables.set(api, table);
  return table;
}

/** Read the host-owned instance table of one author API. */
export function readInstanceTable(api: PluginApi): ContributionInstanceTable {
  const table = tables.get(api);
  if (!table) throw new Error('PluginApi was not created by the host loader');
  return table;
}

export class ContributionInstanceTable {
  private entries: ContributionInstanceEntry[] = [];

  /**
   * Record one Host-accepted instance and wrap its retirement method so the
   * entry retires together with the instance. Wrapping happens here — the
   * single registration path — so every Host teardown call site is covered
   * without explicit retire calls.
   *
   * Acceptance semantics:
   * - a newer instance for the same (kind, key, label) supersedes the previous
   *   one (config hot-reload replace); the superseded entry is marked retired;
   * - re-accepting the *same* object (singleton factories) refreshes its label
   *   instead of double-registering it;
   * - an instance that cannot be tracked is **not registered**: a non-object
   *   product, a frozen/sealed object whose retirement method cannot be
   *   wrapped, or (channels) a product without `stop` — in every case the
   *   Host's own contract validation is the authority that reports the broken
   *   adapter, and this method never invents methods it does not own.
   *
   * @param opts - Instance identity and retirement wiring
   * @returns Whether the instance was registered (tracked)
   */
  attach(opts: {
    kind: ContributionInstanceKind;
    key: string;
    label: string;
    instance: object;
    retireMethod: RetirementMethod;
    defineRetire: boolean;
  }): boolean {
    const target = opts.instance as Record<string, unknown> | null | undefined;
    // Callables are valid contract objects; only primitives/null are not.
    if (typeof target !== 'object' && typeof target !== 'function') return false;
    if (target === null || target === undefined) return false;

    const same = this.entries.find(
      (entry) => entry.kind === opts.kind && entry.key === opts.key && entry.instance === target,
    );
    if (same) {
      // Re-acceptance (e.g. a singleton factory product that was retired and
      // is being served again): the instance is live again as of now.
      same.label = opts.label;
      same.state = 'live';
      return true;
    }

    const original = target[opts.retireMethod];
    const entry: ContributionInstanceEntry = {
      kind: opts.kind,
      key: opts.key,
      label: opts.label,
      instance: target,
      state: 'live',
      superseded: [],
    };
    const retire = (): void => {
      entry.state = 'retired';
    };
    if (typeof original === 'function') {
      try {
        target[opts.retireMethod] = function (this: unknown, ...args: unknown[]): unknown {
          retire();
          return (original as (...a: unknown[]) => unknown).apply(target, args);
        };
      } catch {
        // Frozen/sealed instance: retirement cannot be tracked. Leaving it
        // unregistered keeps lookup honest ("never instantiated") instead of
        // handing out an instance the Host has already stopped.
        return false;
      }
    } else if (opts.defineRetire) {
      try {
        target[opts.retireMethod] = retire;
      } catch {
        return false;
      }
    } else {
      // Missing mandatory lifecycle method: a broken adapter. The Host's
      // contract validation reports it; never patch `stop` here or that check
      // would stop being honest. Untracked for the same reason as frozen.
      return false;
    }

    // Logical retirement of the superseded instance (recorded for rollback),
    // then prune retired tombstones to one per (kind, key) — lookup only
    // distinguishes "was retired" from "never instantiated", so one tombstone
    // is enough. Pruned tombstones stay reachable through `superseded`.
    for (const prior of this.entries) {
      if (prior.kind === opts.kind && prior.key === opts.key && prior.label === opts.label && prior.state === 'live') {
        prior.state = 'retired';
        entry.superseded.push(prior);
      }
    }
    const retired = this.entries.filter(
      (e) => e.kind === opts.kind && e.key === opts.key && e.state === 'retired',
    );
    for (const tomb of retired.slice(0, -1)) {
      this.entries.splice(this.entries.indexOf(tomb), 1);
    }
    this.entries.push(entry);
    return true;
  }

  /**
   * Every recorded entry for one contribution key (live and retired).
   *
   * @param kind - Contribution kind
   * @param key - Contribution key
   * @returns Matching entries in instantiation order
   */
  find(kind: ContributionInstanceKind, key: string): readonly ContributionInstanceEntry[] {
    return this.entries.filter((entry) => entry.kind === kind && entry.key === key);
  }

  /**
   * Logical retirement by instance identity — called by the Host when it
   * stops routing to an instance (removal, hot-reload replace, config reset).
   * Idempotent; the wrapped lifecycle method remains the physical backstop.
   *
   * @param instance - The instance object the Host stopped routing to
   */
  retireByInstance(instance: object): void {
    for (const entry of this.entries) {
      if (entry.instance === instance) entry.state = 'retired';
    }
  }

  /**
   * Roll back an acceptance of an instance that was validated but never
   * installed (the Host aborted before routing to it). Removes its entry and
   * resurrects the entries it superseded, so "live" again matches what the
   * Host serves. No-op once the entry is not the current live one.
   *
   * @param instance - The accepted-but-never-installed instance
   */
  discardByInstance(instance: object): void {
    const entry = this.entries.find((e) => e.instance === instance);
    if (!entry || entry.state !== 'live') return;
    this.entries.splice(this.entries.indexOf(entry), 1);
    for (const prior of entry.superseded) {
      prior.state = 'live';
      if (!this.entries.includes(prior)) this.entries.push(prior);
    }
  }
}
