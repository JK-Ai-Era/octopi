/** Public author API. Runtime ownership lives in PluginContributionRegistry. */

import { resolve, join } from 'node:path';
import { mkdir, chmod } from 'node:fs/promises';
import { getOctopiHome } from '../../../../paths.js';
import { CredentialStore } from '../../../governance/credentials/store.js';
import type { CredentialConsumerRef } from '../../../governance/credentials/types.js';
import { TOOL_CAPABILITIES, type ToolDefinition, type ToolHandler } from '@octopi-agent/core/types.js';
import { CONTRIBUTION_NAME_RE, type PluginHookName, type PluginSessionOpName } from './manifest.js';
import { COMMAND_KIND, CHANNEL_KIND, HOOK_KIND, PROVIDER_KIND, SERVICE_KIND, TOOL_KIND, stageContribution } from './contribution-kinds.js';
import { createInstanceTable, readInstanceTable, type ContributionInstanceKind } from './contribution-instances.js';
import { createStaging, readStaging } from './staging.js';

export type { ContributionInstanceKind } from './contribution-instances.js';
import type {
  ExtensionHookHandler,
  HookEvent,
  HookResult,
  HookServiceRegistration,
  HookModelSelection,
  HookIterationTransform,
  HookVote,
} from '../hooks/types.js';
import type { ArgSpec, CommandInvoker, CommandKind, CommandResult, CommandRisk } from '../commands/types.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import { normalizeCommandName } from '../commands/parse.js';
import { COMMAND_INVOKERS } from '../commands/types.js';

export interface PluginCommandContext {
  sessionId: string;
  agentId: string;
  args: string[];
  raw: string;
  principal: { actorId?: string; actorType?: string; tenantId?: string };
}

/**
 * Per-plugin secret storage backed by the Host credentials vault
 * (`OCTOPI_HOME/credentials/credentials.db`, AES-GCM). Values live in the
 * plugin's own namespace (`plugin:<id>:<key>`) and are bound to the plugin as
 * consumer — no other consumer can resolve them. Plaintext returned by `get`
 * is short-lived: never log or persist it.
 */
export interface PluginSecrets {
  /**
   * Read a secret value in this plugin's namespace.
   *
   * @param key - Secret key (`[A-Za-z0-9._-]+`)
   * @returns Plaintext value, or null when absent
   */
  get(key: string): Promise<string | null>;
  /**
   * Write or rotate a secret in this plugin's namespace.
   *
   * @param key - Secret key (`[A-Za-z0-9._-]+`)
   * @param value - Plaintext value (encrypted at rest, never echoed)
   */
  set(key: string, value: string): Promise<void>;
  /**
   * Delete a secret from this plugin's namespace.
   *
   * @param key - Secret key
   * @returns Whether a stored secret was removed
   */
  delete(key: string): Promise<boolean>;
}

const SECRET_KEY_RE = /^[A-Za-z0-9._-]+$/;

/** Vault-backed secrets scoped to one plugin (`plugin:<id>:<key>` namespace). */
function createPluginSecrets(
  pluginId: string,
  storeOf: () => Promise<CredentialStore>,
): PluginSecrets {
  const consumer = { kind: 'plugin' as const, id: pluginId };
  const nameOf = (key: string): string => {
    if (typeof key !== 'string' || !SECRET_KEY_RE.test(key)) {
      throw new Error(
        `Plugin "${pluginId}" invalid secret key "${String(key)}": expected [A-Za-z0-9._-]+`,
      );
    }
    return `plugin:${pluginId}:${key}`;
  };
  return {
    async get(key) {
      const store = await storeOf();
      return store.reveal(nameOf(key), consumer);
    },
    async set(key, value) {
      if (typeof value !== 'string' || value === '') {
        throw new Error(`Plugin "${pluginId}" secret "${key}" value must be a non-empty string`);
      }
      const store = await storeOf();
      const name = nameOf(key);
      store.set({
        name,
        kind: 'api_key',
        description: `plugin:${pluginId} secret`,
        secretMode: 'encrypted',
        secretValue: value,
        scope: { level: 'plugin', key: pluginId },
      });
      // Own-or-revoke: a secret written here belongs to this plugin only —
      // bindings left over from a hand-provisioned row are revoked so the
      // "only resolvable consumer" claim cannot be silently falsified.
      for (const bound of store.listBindings(name)) {
        if (bound.kind !== 'plugin' || bound.id !== pluginId) {
          store.unbind({ kind: bound.kind as CredentialConsumerRef['kind'], id: bound.id }, name);
        }
      }
      store.bind(consumer, name);
    },
    async delete(key) {
      const store = await storeOf();
      return store.delete(nameOf(key));
    },
  };
}

export interface PluginCommandRegistration {
  name: string;
  description?: string;
  /** Client-side commands require a client contract and are not Plugin v1 contributions. */
  kind?: Exclude<CommandKind, 'client'>;
  risk?: CommandRisk;
  invocableBy?: CommandInvoker[];
  args?: ArgSpec[];
  preempt?: boolean;
  sessionOps?: PluginSessionOpName[];
  handler: (context: PluginCommandContext) => Promise<CommandResult | string | void | unknown>;
}

export type PluginHookMap = {
  [K in PluginHookName]: [HookEvent<K>, HookResult<K>];
};

export type HookHandler<K extends PluginHookName = PluginHookName> = ExtensionHookHandler<K>;

export type HookResultFor<K extends PluginHookName, P extends 'transform' | 'vote'> =
  K extends 'before_tool_call'
    ? P extends 'transform' ? Record<string, unknown> | void : HookVote | void
    : K extends 'before_iteration'
      ? P extends 'transform' ? HookIterationTransform | void : HookVote | void
      : never;

export interface OrderedHookEntry {
  pluginId: string;
  hookName: PluginHookName;
  handler: (event: never) => unknown;
  phase: 'single' | 'transform' | 'vote';
  priority: number;
  timeoutMs?: number;
}

export interface PluginToolContribution {
  definition: ToolDefinition;
  handler: ToolHandler;
  optional: boolean;
  executionMode?: 'parallel' | 'sequential';
}

export interface ToolRegistrationOptions {
  /** Visibility is separately controlled by the Agent's tools allow/deny policy. */
  optional?: boolean;
  executionMode?: 'parallel' | 'sequential';
}

/** Normalized model entry handed to plugin provider factories (mirrors built-in adapters). */
export interface PluginProviderModelEntry {
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  reasoning?: boolean;
  input?: Array<'text' | 'image' | 'audio' | 'video'>;
}

/**
 * Factory context: everything a plugin needs to build a Core ModelProvider for
 * one `models.providers` config instance.
 */
export interface PluginProviderFactoryContext {
  /** The `models.providers` key being instantiated. */
  providerName: string;
  baseUrl: string;
  /** `${ENV_VAR}` placeholders already expanded; empty string means keyless. */
  apiKey: string;
  models: PluginProviderModelEntry[];
  defaultModel?: string;
  timeoutMs?: number;
  /**
   * `models.providers[key].options` passed through verbatim. Non-secret tuning
   * knobs only — secrets belong in `apiKey` (credential channel), never here.
   */
  options: Record<string, unknown>;
}

/**
 * Provider factory staged by registerProvider. The Host calls it when a
 * `models.providers` entry references this contribution via its `plugin` field
 * (startup or config hot-reload), never at registration time.
 */
export type PluginProviderFactory = (
  context: PluginProviderFactoryContext,
) => ModelProvider | Promise<ModelProvider>;

export interface PluginProviderRegistration {
  id: string;
  factory: PluginProviderFactory;
}

/**
 * Factory context: everything a plugin needs to build a Gateway ChannelAdapter
 * for one `channels` config instance.
 */
export interface PluginChannelFactoryContext {
  /** The `channels` entry's `plugin` contribution id being instantiated. */
  channelName: string;
  /** `${ENV_VAR}` placeholders already expanded; empty string means keyless. */
  apiKey: string;
  /**
   * `channels[].options` passed through verbatim. Non-secret tuning knobs only —
   * secrets belong in `apiKey` (credential channel), never here.
   */
  options: Record<string, unknown>;
}

/**
 * Channel factory staged by registerChannel. The Host calls it when a `channels`
 * entry references this contribution via its `plugin` field (startup), never at
 * registration time.
 */
export type PluginChannelFactory = (
  context: PluginChannelFactoryContext,
) => PluginChannelAdapterLike | Promise<PluginChannelAdapterLike>;

/**
 * Structural view of the ChannelAdapter SPI (`../channel-types.js`) kept local
 * so the author API does not widen its import surface. The Host verifies the
 * produced adapter and hard-binds its `name` to the config key.
 */
export interface PluginChannelAdapterLike {
  name: string;
  start(handler: (msg: import('../channel-types.js').ChannelMessage) => Promise<void>): Promise<void>;
  send(reply: import('../channel-types.js').ChannelReply): Promise<void>;
  stop(): Promise<void>;
}

export interface PluginChannelRegistration {
  id: string;
  factory: PluginChannelFactory;
}

export interface HookRegistrationOptions {
  /** Required for the two dual-phase events; ordinary events must not set it. */
  phase?: 'transform' | 'vote';
  priority?: number;
  timeoutMs?: number;
}

export interface DualPhaseHookOptions {
  phase: 'transform' | 'vote';
  priority?: number;
  timeoutMs?: number;
}

export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export class PluginApi {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly source: string;
  readonly rootDir: string;
  readonly pluginConfig: Record<string, unknown>;
  readonly logger: PluginLogger;
  /** Per-plugin secret storage backed by the Host credentials vault. */
  readonly secrets: PluginSecrets;
  private readonly stateDirPath: string;
  private credentialStore?: CredentialStore;
  private readonly injectedCredentialStore?: CredentialStore;

  constructor(opts: {
    id: string;
    name: string;
    version: string;
    description?: string;
    source: string;
    rootDir: string;
    pluginConfig: Record<string, unknown>;
    /** Override for the per-plugin state directory (tests / custom layouts). */
    stateDir?: string;
    /** Shared credentials vault; falls back to `CredentialStore.openDefault`. */
    credentialStore?: CredentialStore;
  }) {
    this.id = opts.id;
    this.name = opts.name;
    this.version = opts.version;
    this.description = opts.description;
    this.source = opts.source;
    this.rootDir = opts.rootDir;
    this.pluginConfig = opts.pluginConfig;
    this.stateDirPath = opts.stateDir ?? join(getOctopiHome(), 'plugin-state', opts.id);
    this.injectedCredentialStore = opts.credentialStore;
    this.secrets = createPluginSecrets(opts.id, () => this.getCredentialStore());
    createStaging(this);
    createInstanceTable(this);
    const prefix = `[plugin:${opts.id}]`;
    this.logger = {
      debug: (message, ...args) => console.debug(`${prefix} ${message}`, ...args),
      info: (message, ...args) => console.info(`${prefix} ${message}`, ...args),
      warn: (message, ...args) => console.warn(`${prefix} ${message}`, ...args),
      error: (message, ...args) => console.error(`${prefix} ${message}`, ...args),
    };
  }

  /**
   * Per-plugin private state directory (`OCTOPI_HOME/plugin-state/<id>`).
   * Created on first access with mode 0700 (and tightened to 0700 when the
   * directory already looser). Runtime state goes here — secrets go through
   * {@link PluginApi.secrets}, never into files.
   */
  get stateDir(): string {
    return this.stateDirPath;
  }

  /** Ensure the state directory exists with 0700. Called by stateDir consumers. */
  async ensureStateDir(): Promise<string> {
    await mkdir(this.stateDirPath, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by umask and does not tighten existing dirs.
    try {
      await chmod(this.stateDirPath, 0o700);
    } catch (error) {
      // Degraded, explicit: a state dir that cannot be tightened is a real
      // security downgrade, never a silent one.
      this.logger.warn(
        `Plugin "${this.id}" stateDir ${this.stateDirPath}: cannot enforce mode 0700 (${String(error)}); state files rely on their own mode`,
      );
    }
    return this.stateDirPath;
  }

  private async getCredentialStore(): Promise<CredentialStore> {
    this.credentialStore ??= this.injectedCredentialStore ?? (await CredentialStore.openDefault(getOctopiHome()));
    return this.credentialStore;
  }

  /**
   * Stage a Tool contribution. It is not mounted or exposed by this call.
   *
   * @param tool - Core ToolDefinition
   * @param handler - Core ToolHandler
   * @param opts - Execution and optional contribution metadata
   */
  registerTool(tool: ToolDefinition, handler: ToolHandler, opts?: ToolRegistrationOptions): void {
    if (!tool.capabilities || tool.capabilities.length === 0) {
      throw new Error(`Plugin tool "${tool.name}" must declare non-empty capabilities`);
    }
    if (new Set(tool.capabilities).size !== tool.capabilities.length ||
      tool.capabilities.some((capability) => !TOOL_CAPABILITIES.includes(capability))) {
      throw new Error(`Plugin tool "${tool.name}" has unknown or duplicate capabilities`);
    }
    const executionMode = opts?.executionMode ??
      (tool.capabilities.includes('fs-write') ? 'sequential' : undefined);
    stageContribution(this.id, TOOL_KIND, readStaging(this), {
      definition: tool,
      handler,
      optional: opts?.optional ?? false,
      ...(executionMode === undefined ? {} : { executionMode }),
    });
  }

  /**
   * Stage a typed hook contribution using one of the 22 existing event names.
   *
   * @param hookName - Existing hook name
   * @param handler - Event-specific handler
   * @param opts - Ordering and cooperative timeout options
   */
  on<K extends PluginHookName>(
    hookName: K,
    handler: HookHandler<K>,
    opts?: HookRegistrationOptions,
  ): void {
    const dualPhase = hookName === 'before_tool_call' || hookName === 'before_iteration';
    if (dualPhase !== (opts?.phase !== undefined)) {
      throw new Error(`Plugin "${this.id}" must ${dualPhase ? 'declare' : 'omit'} phase for hook "${hookName}"`);
    }
    if (opts?.priority !== undefined && !Number.isFinite(opts.priority)) {
      throw new Error(`Plugin "${this.id}" registered invalid hook priority`);
    }
    if (opts?.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) {
      throw new Error(`Plugin "${this.id}" registered invalid hook timeout`);
    }
    const entry: OrderedHookEntry = {
      pluginId: this.id,
      hookName,
      handler: handler as (event: never) => unknown,
      phase: opts?.phase ?? 'single',
      priority: opts?.priority ?? 0,
      ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    };
    stageContribution(this.id, HOOK_KIND, readStaging(this), entry);
  }

  /** Register a parameter Transform or admission Vote for before_tool_call. */
  onBeforeToolCall<P extends 'transform' | 'vote'>(
    phase: P,
    handler: (event: HookEvent<'before_tool_call'>) =>
      HookResultFor<'before_tool_call', P> | Promise<HookResultFor<'before_tool_call', P>>,
    opts?: Omit<DualPhaseHookOptions, 'phase'>,
  ): void {
    this.on('before_tool_call', handler as HookHandler<'before_tool_call'>, { ...opts, phase });
  }

  /** Register a controlled Iteration Transform or admission Vote. */
  onBeforeIteration<P extends 'transform' | 'vote'>(
    phase: P,
    handler: (event: HookEvent<'before_iteration'>) =>
      HookResultFor<'before_iteration', P> | Promise<HookResultFor<'before_iteration', P>>,
    opts?: Omit<DualPhaseHookOptions, 'phase'>,
  ): void {
    this.on('before_iteration', handler as HookHandler<'before_iteration'>, { ...opts, phase });
  }

  /** Stage a Host-owned background service; start/stop is driven by Gateway. */
  registerService(registration: HookServiceRegistration): void {
    if (!registration.serviceId.trim()) {
      throw new Error(`Plugin "${this.id}" registered an empty service id`);
    }
    if (registration.timeoutMs !== undefined && (!Number.isFinite(registration.timeoutMs) || registration.timeoutMs <= 0)) {
      throw new Error(`Plugin "${this.id}" registered an invalid service timeout`);
    }
    stageContribution(this.id, SERVICE_KIND, readStaging(this), { ...registration });
  }

  /**
   * Stage a model Provider factory. The Host instantiates it when a
   * `models.providers` entry references this id via its `plugin` field.
   *
   * @param id - Stable provider id (globally unique across plugins, like services)
   * @param factory - Builds a Core ModelProvider for one config instance
   */
  registerProvider(id: string, factory: PluginProviderFactory): void {
    const normalized = id.trim();
    if (!CONTRIBUTION_NAME_RE.test(normalized) || typeof factory !== 'function') {
      throw new Error(`Plugin "${this.id}" registered an invalid provider contribution "${id}"`);
    }
    stageContribution(this.id, PROVIDER_KIND, readStaging(this), { id: normalized, factory });
  }

  /**
   * Stage a Gateway channel factory. The Host instantiates it when a `channels`
   * entry references this id via its `plugin` field.
   *
   * @param id - Stable channel id (globally unique across plugins, like providers)
   * @param factory - Builds a ChannelAdapter for one channels config instance
   */
  registerChannel(id: string, factory: PluginChannelFactory): void {
    const normalized = id.trim();
    if (!CONTRIBUTION_NAME_RE.test(normalized) || typeof factory !== 'function') {
      throw new Error(`Plugin "${this.id}" registered an invalid channel contribution "${id}"`);
    }
    stageContribution(this.id, CHANNEL_KIND, readStaging(this), { id: normalized, factory });
  }

  /**
   * Look up the live runtime instance the Host serves for one of this
   * plugin's own factory-backed contributions (providers, channels). The
   * instance is registered when the Host accepts the factory product (after
   * contract validation) and retires when its lifecycle method runs (`stop()`
   * for channels, `dispose()` for providers — recorded when the call is
   * requested, regardless of the outcome) or when a newer instance for the
   * same config identity supersedes it (hot-reload replace; the superseded
   * instance may still serve draining in-flight work).
   *
   * Exactly-one semantics: the lookup succeeds only while exactly one live
   * instance exists. It throws a real error when the contribution was never
   * instantiated, when its instance was retired, when several instances are
   * live at once (multi-instance providers must capture per-instance handles
   * in their factory closure instead), or when the key is not a contribution
   * of this plugin (cross-plugin lookup is not part of the v1 contract).
   *
   * @param kind - 'provider' or 'channel'
   * @param id - Contribution key (the id passed to registerProvider/registerChannel)
   * @returns The live instance the Host serves for this contribution
   */
  getContributionInstance(kind: 'provider', id: string): ModelProvider;
  getContributionInstance(kind: 'channel', id: string): PluginChannelAdapterLike;
  getContributionInstance(kind: ContributionInstanceKind, id: string): object;
  getContributionInstance(kind: ContributionInstanceKind, id: string): object {
    if (kind !== 'provider' && kind !== 'channel') {
      throw new Error(
        `Plugin "${this.id}" cannot look up instances of kind "${String(kind)}": expected "provider" or "channel"`,
      );
    }
    if (typeof id !== 'string') {
      throw new Error(`Plugin "${this.id}" cannot look up ${kind} instance "${String(id)}": id must be a string`);
    }
    const key = id.trim();
    const staging = readStaging(this);
    const owns = kind === 'provider'
      ? staging.providers.some((entry) => entry.id === key)
      : staging.channels.some((entry) => entry.id === key);
    if (!owns) {
      throw new Error(`Plugin "${this.id}" cannot look up ${kind} "${key}": not a contribution of this plugin`);
    }
    const entries = readInstanceTable(this).find(kind, key);
    const live = entries.filter((entry) => entry.state === 'live');
    if (live.length === 1) return live[0].instance;
    if (live.length > 1) {
      const labels = live.map((entry) => `"${entry.label}"`).join(', ');
      throw new Error(
        `Plugin "${this.id}" ${kind} "${key}" has ${live.length} live instances (${labels}): getContributionInstance requires exactly one`,
      );
    }
    if (entries.length > 0) {
      throw new Error(`Plugin "${this.id}" ${kind} "${key}" has no live instance (its instance was retired)`);
    }
    throw new Error(`Plugin "${this.id}" ${kind} "${key}" has no live instance (the Host has not instantiated it)`);
  }

  /**
   * Stage a Command contribution. Host authorization is enforced when mounted.
   *
   * @param definition - Command metadata and handler
   */
  registerCommand(definition: PluginCommandRegistration): void {
    const name = normalizeCommandName(definition.name);
    if (!name) throw new Error(`Plugin "${this.id}" registered invalid command name`);
    if (definition.kind !== undefined && definition.kind !== 'control' && definition.kind !== 'prompt') {
      throw new Error(`Plugin "${this.id}" registered unsupported kind for command "${name}"`);
    }
    if (definition.invocableBy && (
      definition.invocableBy.length === 0 ||
      new Set(definition.invocableBy).size !== definition.invocableBy.length ||
      definition.invocableBy.some((invoker) => !COMMAND_INVOKERS.includes(invoker))
    )) {
      throw new Error(`Plugin "${this.id}" registered invalid invocableBy for command "${name}"`);
    }
    const staging = readStaging(this);
    stageContribution(this.id, COMMAND_KIND, staging, { ...definition, name });
  }

  /**
   * Resolve a path relative to the plugin root in ESM.
   *
   * @param input - Relative or absolute path
   * @returns Absolute path; not a filesystem security boundary
   */
  resolvePath(input: string): string {
    return resolve(this.rootDir, input);
  }
}
