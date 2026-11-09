import { getOctopiHome } from '../../../../paths.js';
import type { PluginLoaderConfig, LoadedPlugin, PluginDiagnostic, PluginEntryConfig } from './loader.js';
import { PluginLoader } from './loader.js';
import type { PluginCommandRecord, PluginToolRecord, PluginServiceRecord, PluginProviderRecord, PluginChannelRecord } from './contribution-registry.js';
import { PluginHookAdapter, type HookExecutionHost } from '../hooks/adapter.js';
import { HookAuditJournal } from '../hooks/journal.js';
import { resolveHitlOutcome, type HitlAskResult, type HitlOutcome } from '../../../governance/human-in-the-loop/decision-cache.js';
import type {
  ExtensionHookPort,
  HookAuditRecord,
  HookToolApproval,
  HookToolEvent,
} from '../hooks/types.js';

/** Host-owned manager; the author SDK never receives this object. */
export class PluginManager {
  private loader: PluginLoader;
  private readonly hookJournal: HookAuditJournal;
  private readonly hookPort: ExtensionHookPort;
  private approvalSink?: (event: HookToolEvent, request: Readonly<HookToolApproval>) => Promise<HitlAskResult>;

  constructor(config?: PluginLoaderConfig) {
    this.loader = new PluginLoader(config ?? { loadPaths: [] });
    this.hookJournal = new HookAuditJournal(() => `${getOctopiHome()}/audit`);
    const host: HookExecutionHost = {
      getHooks: () => this.loader.contributions.getHooks(),
      getPluginConfig: (pluginId) => this.getHookConfig(pluginId),
      recordHook: (record) => this.recordHook(record),
      approveToolCall: (event, request, pluginId) => this.approveToolCall(event, request, pluginId),
    };
    this.hookPort = new PluginHookAdapter(host);
  }

  getDiagnostics(): PluginDiagnostic[] { return this.loader.getDiagnostics(); }
  async discover(): Promise<LoadedPlugin[]> { return this.loader.discover(); }
  getAllPlugins(): LoadedPlugin[] { return this.loader.getAllPlugins(); }
  getRegisteredIds(): string[] { return this.loader.getRegisteredIds(); }
  getPlugin(id: string): LoadedPlugin | undefined { return this.loader.getPlugin(id); }

  /** Narrow interception Port for Harness/Gateway consumers, not the whole Manager. */
  getHookPort(): ExtensionHookPort { return this.hookPort; }

  /** Shared append-only audit sink for Host service lifecycle records. */
  getHookAudit(): HookAuditJournal { return this.hookJournal; }

  /** Install the Host's existing high-risk HITL channel; no channel fails closed. */
  setToolApprovalSink(sink: (event: HookToolEvent, request: Readonly<HookToolApproval>) => Promise<HitlAskResult>): void {
    this.approvalSink = sink;
  }

  getTools(includeOptional = false): PluginToolRecord[] {
    return this.loader.contributions.getTools().filter((tool) => includeOptional || !tool.optional);
  }

  getCommands(): PluginCommandRecord[] { return this.loader.contributions.getCommands(); }
  getServices(): PluginServiceRecord[] { return this.loader.contributions.getServices(); }

  getProviders(): PluginProviderRecord[] { return this.loader.contributions.getProviders(); }

  getChannels(): PluginChannelRecord[] { return this.loader.contributions.getChannels(); }

  /** Resolve a published provider factory by its globally unique contribution id. */
  resolveProviderFactory(ref: string): PluginProviderRecord | undefined {
    return this.loader.contributions.getProviders().find((provider) => provider.id === ref);
  }

  /** Resolve a published channel factory by its globally unique contribution id. */
  resolveChannelFactory(ref: string): PluginChannelRecord | undefined {
    return this.loader.contributions.getChannels().find((channel) => channel.id === ref);
  }

  /**
   * Roll back an accepted-but-never-installed instance (config-apply abort);
   * resurrects the instance it superseded in the instance tables.
   *
   * @param instance - The instance the Host validated but never routed to
   */
  discardInstance(instance: object): void {
    this.loader.contributions.discardInstance(instance);
  }

  /**
   * Logical instance retirement at Host routing removal (physical dispose
   * remains the backstop).
   *
   * @param instance - The instance the Host stopped routing to
   */
  retireInstance(instance: object): void {
    this.loader.contributions.retireInstance(instance);
  }

  getCommandSessionOps(pluginId: string, name: string): PluginCommandRecord['sessionOps'] | undefined {
    const command = this.loader.contributions.getCommands().find(
      (candidate) => candidate.pluginId === pluginId &&
        candidate.name.replace(/^\/+/, '').toLowerCase() === name,
    );
    if (!command) return undefined;
    const manifest = this.loader.contributions.getPlugin(pluginId)?.manifest;
    const declared = manifest?.contributes?.commands?.find((candidate) => candidate.name === command.name);
    if (!declared) return undefined;
    return [...(declared.sessionOps ?? [])];
  }

  private getHookConfig(pluginId: string): PluginEntryConfig | undefined {
    return this.loader.getPluginConfig(pluginId);
  }

  private async recordHook(record: HookAuditRecord): Promise<void> {
    await this.hookJournal.append(record);
  }

  private async approveToolCall(
    event: HookToolEvent,
    request: Readonly<HookToolApproval>,
    pluginId: string,
  ): Promise<HitlOutcome> {
    if (!this.approvalSink) {
      return {
        allowed: false,
        decision: 'deny',
        timedOut: false,
        denyReason: 'no_channel',
        denyDetail: 'No Host approval channel is configured for before_tool_call',
      };
    }
    const sink = this.approvalSink;
    // SEC-7 single model: the engine remembers approve_session / approve_always
    // (the Host must not cache), so the scope the human chose is actually honored.
    return resolveHitlOutcome({
      channel: 'plugin_hook',
      // Key = asking policy identity + tool name: a session/always grant must never
      // silently satisfy another plugin's approval question for the same tool.
      // Accepted residual semantics: the grant is tool-level, not argument-level —
      // later parameter variants of the same tool+plugin ride the same decision
      // (same contract as the builtin high_risk channel's tool-name key).
      key: `${pluginId}:${event.toolName}`,
      sessionId: event.sessionId,
      agentId: event.agentId,
      ask: async () => {
        try {
          return await sink(event, request);
        } catch (error) {
          // Channel failure is a denial source, never a human rejection and never an allow.
          return {
            decision: 'deny',
            denyReason: 'channel_error',
            denyDetail: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
  }
}
