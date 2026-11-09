/** Public author API. Runtime ownership lives in PluginContributionRegistry. */

import { resolve } from 'node:path';
import { TOOL_CAPABILITIES, type ToolDefinition, type ToolHandler } from '@octopi-agent/core/types.js';
import { CONTRIBUTION_NAME_RE, type PluginHookName, type PluginSessionOpName } from './manifest.js';
import { COMMAND_KIND, CHANNEL_KIND, HOOK_KIND, PROVIDER_KIND, SERVICE_KIND, TOOL_KIND, stageContribution } from './contribution-kinds.js';
import { createStaging, readStaging } from './staging.js';
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


  constructor(opts: {
    id: string;
    name: string;
    version: string;
    description?: string;
    source: string;
    rootDir: string;
    pluginConfig: Record<string, unknown>;
  }) {
    this.id = opts.id;
    this.name = opts.name;
    this.version = opts.version;
    this.description = opts.description;
    this.source = opts.source;
    this.rootDir = opts.rootDir;
    this.pluginConfig = opts.pluginConfig;
    createStaging(this);
    const prefix = `[plugin:${opts.id}]`;
    this.logger = {
      debug: (message, ...args) => console.debug(`${prefix} ${message}`, ...args),
      info: (message, ...args) => console.info(`${prefix} ${message}`, ...args),
      warn: (message, ...args) => console.warn(`${prefix} ${message}`, ...args),
      error: (message, ...args) => console.error(`${prefix} ${message}`, ...args),
    };
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
