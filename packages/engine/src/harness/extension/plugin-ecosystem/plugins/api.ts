/** Public author API. Runtime ownership lives in PluginContributionRegistry. */

import { resolve } from 'node:path';
import { TOOL_CAPABILITIES, type ToolDefinition, type ToolHandler } from '@octopi-agent/core/types.js';
import type { PluginHookName, PluginSessionOpName } from './manifest.js';
import { createStaging, readStaging } from './staging.js';
import type {
  AgentFinalizeResult,
  AgentReplyResult,
  AgentRunResult,
  AgentTurnPrepareEvent,
  AfterIterationEvent,
  AfterToolCallEvent,
  BeforeAgentFinalizeEvent,
  BeforeAgentReplyEvent,
  BeforeAgentRunEvent,
  BeforeInstallEvent,
  BeforeIterationEvent,
  BeforeIterationResult,
  BeforeModelResolveEvent,
  BeforePromptBuildEvent,
  BeforeToolCallEvent,
  CompactionEvent,
  GatewayLifecycleEvent,
  InstallResult,
  LoopEndEvent,
  MessageReceivedEvent,
  MessageSendingEvent,
  MessageSendingResult,
  MessageSentEvent,
  ModelResolveResult,
  PromptBuildResult,
  SessionLifecycleEvent,
  ToolCallResult,
} from './manager.js';
import type { ArgSpec, CommandInvoker, CommandKind, CommandResult, CommandRisk } from '../commands/types.js';
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

export interface PluginHookMap {
  before_model_resolve: [BeforeModelResolveEvent, ModelResolveResult | void];
  agent_turn_prepare: [AgentTurnPrepareEvent, string | void];
  before_prompt_build: [BeforePromptBuildEvent, PromptBuildResult | void];
  before_agent_run: [BeforeAgentRunEvent, AgentRunResult | void];
  before_agent_reply: [BeforeAgentReplyEvent, AgentReplyResult | void];
  before_agent_finalize: [BeforeAgentFinalizeEvent, AgentFinalizeResult | void];
  agent_end: [import('./manager.js').AgentEndEvent, void];
  before_tool_call: [BeforeToolCallEvent, ToolCallResult | void];
  after_tool_call: [AfterToolCallEvent, void];
  message_received: [MessageReceivedEvent, void];
  message_sending: [MessageSendingEvent, MessageSendingResult | void];
  message_sent: [MessageSentEvent, void];
  session_start: [SessionLifecycleEvent, void];
  session_end: [SessionLifecycleEvent, void];
  before_compaction: [CompactionEvent, void];
  after_compaction: [CompactionEvent, void];
  gateway_start: [GatewayLifecycleEvent, void];
  gateway_stop: [GatewayLifecycleEvent, void];
  before_install: [BeforeInstallEvent, InstallResult | void];
  before_iteration: [BeforeIterationEvent, BeforeIterationResult | void];
  after_iteration: [AfterIterationEvent, void];
  loop_end: [LoopEndEvent, void];
}

export type HookHandler<K extends PluginHookName = PluginHookName> = (
  event: PluginHookMap[K][0],
) => Promise<PluginHookMap[K][1]>;

type AnyHookHandler = {
  [K in PluginHookName]: (event: PluginHookMap[K][0]) => Promise<PluginHookMap[K][1]>;
}[PluginHookName];

export interface OrderedHookEntry<K extends PluginHookName = PluginHookName> {
  pluginId: string;
  hookName: K;
  handler: AnyHookHandler;
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

export interface HookRegistrationOptions {
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
    if (readStaging(this).tools.some((entry) => entry.definition.name === tool.name)) {
      throw new Error(`Plugin "${this.id}" registered duplicate tool "${tool.name}"`);
    }
    const executionMode = opts?.executionMode ??
      (tool.capabilities.includes('fs-write') ? 'sequential' : undefined);
    readStaging(this).tools.push({
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
    const entry = {
      pluginId: this.id,
      hookName,
      handler: handler as AnyHookHandler,
      priority: opts?.priority ?? 0,
      ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    } as OrderedHookEntry;
    const entries = [...(readStaging(this).hooks.get(hookName) ?? []), entry];
    entries.sort((a, b) => b.priority - a.priority);
    readStaging(this).hooks.set(hookName, entries);
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
    if (readStaging(this).commands.some((entry) => entry.name === name)) {
      throw new Error(`Plugin "${this.id}" registered duplicate command "${definition.name}"`);
    }
    readStaging(this).commands.push({ ...definition, name });
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
