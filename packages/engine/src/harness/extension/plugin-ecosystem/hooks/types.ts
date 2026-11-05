import type { Message, ThinkingLevel, ToolCall, ToolResult } from '@octopi-agent/core/types.js';
import type { HitlOutcome } from '../../../governance/human-in-the-loop/decision-cache.js';
import type { ChannelMessage, ChannelReply } from '../channel-types.js';
import type { PluginHookName } from '../plugins/manifest.js';

/** Per-call execution facts; a missing Port performs no plugin work. */
export interface ExtensionHookContext {
  sessionId: string;
  agentId: string;
  runId?: string;
  principal?: { actorId?: string; actorType?: string; tenantId?: string };
  signal?: AbortSignal;
  trace?: { traceId?: string; spanId?: string };
}

export interface HookContribution<T> {
  pluginId: string;
  value: T;
}

export interface HookVote {
  decision: 'allow' | 'deny' | 'require_approval';
  reason?: string;
  pluginId?: string;
  /** Only before_tool_call may request the Host's existing HITL channel. */
  approval?: HookToolApproval;
}

export interface HookTransformResult<T> {
  value: T;
  changes: HookContribution<unknown>[];
}

export interface HookCollectResult<T> {
  contributions: HookContribution<T>[];
}

export interface HookFailure {
  pluginId: string;
  hookName: PluginHookName;
  reason: 'error' | 'timeout' | 'aborted';
  message: string;
}

export interface HookServiceRegistration {
  serviceId: string;
  required?: boolean;
  timeoutMs?: number;
  start?: (signal: AbortSignal) => void | Promise<void>;
  stop?: (signal: AbortSignal) => void | Promise<void>;
}

export interface HookModelSelection {
  provider: string;
  model: string;
}

export interface HookModelSelectionEvent extends ExtensionHookContext {
  current: Readonly<HookModelSelection>;
  prompt: string;
}

export interface HookTurnEvent extends ExtensionHookContext {
  prompt: string;
  messages: readonly Message[];
}

export interface HookPromptBuildEvent extends HookTurnEvent {
  runId: string;
}

export interface HookPromptContribution {
  text: string;
}

export interface HookRunEvent extends ExtensionHookContext {
  runId: string;
  prompt: string;
  messages: readonly Message[];
}

export interface HookReplyEvent extends HookRunEvent {}
export interface HookFinalizeEvent extends ExtensionHookContext {
  runId: string;
  reply: Readonly<Message>;
}

export interface HookRunEndEvent extends ExtensionHookContext {
  runId: string;
  messages: readonly Message[];
  durationMs: number;
  /** Exact terminal cause: completed | should_stop | aborted | error | denied (observation-layer label). */
  reason: string;
  /** True only for clean terminal ends (completed / should_stop); aborted / error / denied are false. */
  success: boolean;
  error?: string;
}

export interface HookToolEvent extends ExtensionHookContext {
  runId: string;
  toolName: string;
  call: Readonly<ToolCall>;
  params: Readonly<Record<string, unknown>>;
}

export interface HookToolApproval {
  title: string;
  description: string;
  severity?: 'info' | 'warning' | 'critical';
  timeoutMs?: number;
  timeoutBehavior?: 'deny';
}

export interface HookToolResultEvent extends ExtensionHookContext {
  runId: string;
  call: Readonly<ToolCall>;
  originalParams: Readonly<Record<string, unknown>>;
  params: Readonly<Record<string, unknown>>;
  result: Readonly<ToolResult>;
  error?: string;
}

export interface HookMessageReceivedEvent extends ExtensionHookContext {
  message: Readonly<ChannelMessage>;
}

export interface HookMessageSendingEvent extends ExtensionHookContext {
  reply: Readonly<ChannelReply>;
}

export interface HookMessageSentEvent extends HookMessageSendingEvent {
  success: boolean;
  error?: string;
}

export interface HookSessionEvent extends ExtensionHookContext {
  reason?: 'created' | 'deleted' | 'archived';
}

export interface HookCompactionEvent extends ExtensionHookContext {
  runId?: string;
  mode: string;
  previousSummary?: string;
  coveredMessageCount?: number;
  compacted?: boolean;
  fresh?: boolean;
  reason?: string;
  error?: string;
}

export interface HookGatewayEvent extends ExtensionHookContext {
  phase: 'started' | 'stopping';
}

export interface HookInstallEvent extends ExtensionHookContext {
  type: 'skill' | 'plugin';
  source: string;
  target: string;
}

export interface HookIterationEvent extends ExtensionHookContext {
  runId: string;
  iteration: number;
  messages: readonly Message[];
  model: HookModelSelection;
  thinking?: ThinkingLevel;
}

export interface HookIterationTransform {
  model?: HookModelSelection;
  thinking?: ThinkingLevel;
  /** Ordered Runtime snapshot additions; never a systemPrompt override. */
  snapshot?: string;
}

export interface HookAfterIterationEvent extends HookIterationEvent {
  assistantMessage: Readonly<Message>;
  toolResults: readonly ToolResult[];
  usage?: import('@octopi-agent/core/types/step.js').TokenUsage;
}

export interface HookLoopEndEvent extends HookRunEndEvent {
  iterations: number;
  response?: string;
}

export interface HookBeforeToolTransform {
  params: Record<string, unknown>;
}

export type ExtensionHookMap = {
  before_model_resolve: [HookModelSelectionEvent, HookModelSelection | void, 'transform'];
  agent_turn_prepare: [HookTurnEvent, string | void, 'transform'];
  before_prompt_build: [HookPromptBuildEvent, HookPromptContribution | string | void, 'collect'];
  before_agent_run: [HookRunEvent, HookVote | void, 'vote'];
  before_agent_reply: [HookReplyEvent, Message | void, 'override'];
  before_agent_finalize: [HookFinalizeEvent, Message | string | void, 'transform'];
  agent_end: [HookRunEndEvent, void, 'observe'];
  before_tool_call: [HookToolEvent, HookBeforeToolTransform | HookVote | void, 'transform_vote'];
  after_tool_call: [HookToolResultEvent, void, 'observe'];
  message_received: [HookMessageReceivedEvent, void, 'observe'];
  message_sending: [HookMessageSendingEvent, HookVote | void, 'vote'];
  message_sent: [HookMessageSentEvent, void, 'observe'];
  session_start: [HookSessionEvent, void, 'observe'];
  session_end: [HookSessionEvent, void, 'observe'];
  before_compaction: [HookCompactionEvent, HookVote | void, 'vote'];
  after_compaction: [HookCompactionEvent, void, 'observe'];
  gateway_start: [HookGatewayEvent, void, 'observe'];
  gateway_stop: [HookGatewayEvent, void, 'observe'];
  before_install: [HookInstallEvent, HookVote | void, 'vote'];
  before_iteration: [HookIterationEvent, HookIterationTransform | HookVote | void, 'transform_vote'];
  after_iteration: [HookAfterIterationEvent, void, 'observe'];
  loop_end: [HookLoopEndEvent, void, 'observe'];
};

export type HookEvent<K extends PluginHookName> = ExtensionHookMap[K][0];
export type HookResult<K extends PluginHookName> = K extends 'before_tool_call'
  ? Record<string, unknown> | HookVote | void
  : K extends 'before_iteration'
    ? HookIterationTransform | HookVote | void
    : ExtensionHookMap[K][1];
export type HookSemantics = 'observe' | 'collect' | 'transform' | 'vote' | 'override' | 'transform_vote';

export type HookAuditRecord = {
  pluginId: string;
  hookName: PluginHookName | 'service_start' | 'service_stop';
  phase: 'observe' | 'collect' | 'transform' | 'vote' | 'override';
  outcome: 'ok' | 'error' | 'timeout' | 'aborted' | 'denied' | 'skipped';
  sessionId: string;
  agentId: string;
  runId?: string;
  principal?: ExtensionHookContext['principal'];
  reason?: string;
  details?: Record<string, unknown>;
};

/**
 * Harness-owned interception boundary. Consumers do not see PluginManager or
 * plugin registrations; the adapter owns cardinality, failures and audit.
 */
export interface ExtensionHookPort {
  /** True when at least one handler is registered for the event (optionally for one phase). */
  hasHooks(name: PluginHookName, phase?: 'single' | 'transform' | 'vote'): boolean;
  observe<K extends PluginHookName>(name: K, event: HookEvent<K>): Promise<void>;
  collect(name: 'before_prompt_build', event: HookPromptBuildEvent): Promise<HookCollectResult<HookPromptContribution>>;
  transform<K extends PluginHookName>(name: K, event: HookEvent<K>, initial: unknown): Promise<HookTransformResult<unknown>>;
  vote<K extends PluginHookName>(name: K, event: HookEvent<K>): Promise<HookVote>;
  override(name: 'before_agent_reply', event: HookReplyEvent): Promise<Message | undefined>;
  transformBeforeToolCall(event: HookToolEvent): Promise<HookTransformResult<Record<string, unknown>>>;
  voteBeforeToolCall(event: HookToolEvent, originalParams: Readonly<Record<string, unknown>>): Promise<HookVote>;
  beforeIteration(event: HookIterationEvent): Promise<{
    transform: HookIterationTransform;
    snapshotContributions: HookContribution<string>[];
    vote: HookVote;
  }>;
  /** Resolved Host HITL decision (engine cache included); `allowed` gates execution. */
  approveToolCall(event: HookToolEvent, request: Readonly<HookToolApproval>, pluginId: string): Promise<HitlOutcome>;
}

export type ExtensionHookHandler<K extends PluginHookName = PluginHookName> = (
  event: HookEvent<K>,
) => HookResult<K> | Promise<HookResult<K>>;
