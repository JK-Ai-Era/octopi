import type {
  ExtensionHookContext,
  ExtensionHookPort,
  HookAuditRecord,
  HookCollectResult,
  HookContribution,
  HookEvent,
  HookIterationEvent,
  HookIterationTransform,
  HookPromptBuildEvent,
  HookPromptContribution,
  HookToolApproval,
  HookToolEvent,
  HookTransformResult,
  HookVote,
} from './types.js';
import type { PluginHookName } from '../plugins/manifest.js';
import type { PluginEntryConfig } from '../plugins/loader.js';
import type { HitlOutcome } from '../../../governance/human-in-the-loop/decision-cache.js';
import type { Message } from '@octopi-agent/core/types.js';

export interface RegisteredHook {
  pluginId: string;
  hookName: PluginHookName;
  /** Explicit phase for dual-phase events; ordinary events use single. */
  phase: 'single' | 'transform' | 'vote';
  priority: number;
  timeoutMs?: number;
  handler: (event: never) => unknown;
}

export interface HookExecutionHost {
  getHooks(): RegisteredHook[];
  getPluginConfig(pluginId: string): PluginEntryConfig | undefined;
  recordHook(record: HookAuditRecord): void | Promise<void>;
  /** Resolved Host HITL decision (engine cache included); ask errors must not escape as allow. */
  approveToolCall(event: HookToolEvent, request: Readonly<HookToolApproval>, pluginId: string): Promise<HitlOutcome>;
}

export class HookDeniedError extends Error {
  constructor(readonly vote: HookVote, readonly hookName: PluginHookName) {
    super(vote.reason ?? `Plugin hook ${hookName} denied the operation`);
    this.name = 'HookDeniedError';
  }
}

export function requireHookApproval(vote: HookVote, hookName: PluginHookName): void {
  if (vote.decision !== 'allow') throw new HookDeniedError(vote, hookName);
}

function isVote(value: unknown): value is HookVote {
  if (value === null || typeof value !== 'object' || !('decision' in value)) return false;
  const decision = (value as HookVote).decision;
  return decision === 'allow' || decision === 'deny' || decision === 'require_approval';
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isParams(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Adapts effective plugin registrations to explicit cardinality operations. */
export class PluginHookAdapter implements ExtensionHookPort {
  constructor(private readonly host: HookExecutionHost) {}

  async observe<K extends PluginHookName>(name: K, event: HookEvent<K>): Promise<void> {
    for (const entry of this.entries(name, 'single')) {
      await this.execute(entry, event, 'observe', async () => {
        await entry.handler(event as never);
      });
    }
  }

  async collect(
    name: 'before_prompt_build',
    event: HookPromptBuildEvent,
  ): Promise<HookCollectResult<HookPromptContribution>> {
    const contributions: HookCollectResult<HookPromptContribution>['contributions'] = [];
    for (const entry of this.entries(name, 'single')) {
      await this.execute(entry, event, 'collect', async () => {
        const result = await entry.handler(event as never) as HookPromptContribution | string | void;
        if (result === undefined) return;
        const value = typeof result === 'string' ? { text: result } : result;
        if (!value || typeof value.text !== 'string') {
          throw new Error('before_prompt_build must return text or {text}');
        }
        if (!value.text.trim()) return;
        contributions.push({ pluginId: entry.pluginId, value: { text: value.text } });
      });
    }
    return { contributions };
  }

  hasHooks(name: PluginHookName, phase?: 'single' | 'transform' | 'vote'): boolean {
    return this.host.getHooks()
      .some((entry) => entry.hookName === name && (phase === undefined || entry.phase === phase));
  }

  async transform<K extends PluginHookName>(
    name: K,
    event: HookEvent<K>,
    initial: unknown,
  ): Promise<HookTransformResult<unknown>> {
    let value = initial;
    const changes: HookContribution<unknown>[] = [];
    for (const entry of this.entries(name, 'single')) {
      const currentEvent = this.transformEvent(name, event, value);
      try {
        const next = await this.invoke(entry, currentEvent);
        if (next !== undefined && next !== null) {
          value = this.transformedValue(name, value, next);
          changes.push({ pluginId: entry.pluginId, value });
        }
        await this.record(entry, name, currentEvent, 'transform', 'ok');
      } catch (error) {
        await this.record(entry, name, currentEvent, 'transform', this.outcome(error), failureMessage(error));
        throw error;
      }
    }
    return { value, changes };
  }

  async vote<K extends PluginHookName>(name: K, event: HookEvent<K>): Promise<HookVote> {
    let final: HookVote = { decision: 'allow' };
    for (const entry of this.entries(name, 'single')) {
      const vote = await this.invokeVote(entry, event);
      if (vote.decision === 'require_approval') {
        final = { decision: 'deny', pluginId: entry.pluginId, reason: `${name} does not support approval votes` };
        await this.record(entry, name, event, 'vote', 'denied', final.reason);
      } else if (vote.decision === 'deny') {
        final = vote;
      }
    }
    return final;
  }

  async override(name: 'before_agent_reply', event: Parameters<ExtensionHookPort['override']>[1]): Promise<Message | undefined> {
    const entries = this.entries(name, 'single');
    if (entries.length === 0) return undefined;
    if (entries.length > 1) {
      const error = new Error(`Override hook ${name} has multiple owners: ${entries.map((entry) => entry.pluginId).join(', ')}`);
      await Promise.all(entries.map((entry) => this.record(entry, name, event, 'override', 'error', error.message)));
      throw error;
    }
    const entry = entries[0]!;
    try {
      const result = await this.invoke(entry, event);
      if (result !== undefined && result !== null) {
        const message = result as unknown as Message;
        if (!isParams(result) || message.role !== 'assistant') {
          throw new Error('before_agent_reply must return an assistant Message');
        }
        if (message.toolCalls?.length) {
          throw new Error('before_agent_reply must not return toolCalls (no tool results would follow)');
        }
        if (typeof message.content !== 'string' && !Array.isArray(message.content)) {
          throw new Error('before_agent_reply must return text or block-array content');
        }
      }
      await this.record(entry, name, event, 'override', 'ok');
      return (result ?? undefined) as Message | undefined;
    } catch (error) {
      await this.record(entry, name, event, 'override', this.outcome(error), failureMessage(error));
      throw error;
    }
  }

  async transformBeforeToolCall(event: HookToolEvent): Promise<HookTransformResult<Record<string, unknown>>> {
    let params = { ...event.params };
    const changes: HookTransformResult<Record<string, unknown>>['changes'] = [];
    for (const entry of this.entries('before_tool_call', 'transform')) {
      const current = { ...event, params: { ...params } };
      try {
        const result = await this.invoke(entry, current);
        if (result !== undefined && result !== null) {
          if (!isParams(result)) throw new Error('before_tool_call Transform must return a parameter object');
          params = { ...result };
          changes.push({ pluginId: entry.pluginId, value: { ...params } });
        }
        await this.record(entry, 'before_tool_call', current, 'transform', 'ok', undefined, {
          toolName: event.toolName,
          callId: event.call.id,
          originalParams: current.params,
          finalParams: { ...params },
        });
      } catch (error) {
        await this.record(entry, 'before_tool_call', current, 'transform', this.outcome(error), failureMessage(error), {
          toolName: event.toolName,
          callId: event.call.id,
          originalParams: event.params,
        });
        throw error;
      }
    }
    return { value: params, changes };
  }

  async voteBeforeToolCall(
    event: HookToolEvent,
    originalParams: Readonly<Record<string, unknown>>,
  ): Promise<HookVote> {
    const pending: Array<{ entry: RegisteredHook; vote: HookVote }> = [];
    let denied: HookVote | undefined;
    for (const entry of this.entries('before_tool_call', 'vote')) {
      const vote = await this.invokeVote(entry, event, {
        toolName: event.toolName,
        callId: event.call.id,
        originalParams,
        params: event.params,
      });
      pending.push({ entry, vote });
      if (vote.decision === 'deny') denied = vote;
    }
    // A deny from any participant wins without prompting for an unnecessary approval.
    if (denied) return denied;
    let final: HookVote = { decision: 'allow' };
    for (const { entry, vote } of pending) {
      if (vote.decision !== 'require_approval') continue;
      if (!vote.approval) {
        const reason = 'require_approval requires an approval request';
        await this.record(entry, 'before_tool_call', event, 'vote', 'denied', reason);
        return { decision: 'deny', pluginId: entry.pluginId, reason };
      }
      const approved = await this.host.approveToolCall(event, vote.approval, entry.pluginId);
      const denyReason = approved.denyDetail
        ?? (approved.timedOut ? 'Host approval timed out' : 'Host approval was not granted');
      await this.record(entry, 'before_tool_call', event, 'vote',
        approved.allowed ? 'ok' : 'denied', approved.allowed ? undefined : denyReason, {
          approval: vote.approval,
          toolName: event.toolName,
          callId: event.call.id,
          hitlDecision: approved.decision,
          ...(approved.timedOut ? { timedOut: true } : {}),
          ...(approved.denyReason === undefined ? {} : { denyReason: approved.denyReason }),
        });
      if (!approved.allowed) {
        return { decision: 'deny', pluginId: entry.pluginId, reason: denyReason };
      }
      // The Host decision resolved this Vote: approved means allow, not "still pending".
      final = { decision: 'allow', pluginId: entry.pluginId };
    }
    return final;
  }

  async beforeIteration(event: HookIterationEvent): Promise<{
    transform: HookIterationTransform;
    snapshotContributions: HookContribution<string>[];
    vote: HookVote;
  }> {
    const transform: HookIterationTransform = {};
    const snapshotContributions: HookContribution<string>[] = [];
    for (const entry of this.entries('before_iteration', 'transform')) {
      const current = {
        ...event,
        model: transform.model ?? event.model,
        thinking: transform.thinking ?? event.thinking,
      };
      try {
        const result = await this.invoke(entry, current) as HookIterationTransform | void;
        if (result) {
          if (typeof result.snapshot === 'string') {
            transform.snapshot = [transform.snapshot, result.snapshot].filter(Boolean).join('\n\n');
            if (result.snapshot.trim()) snapshotContributions.push({ pluginId: entry.pluginId, value: result.snapshot });
          }
          if (result.model) transform.model = { ...result.model };
          if (result.thinking !== undefined) transform.thinking = result.thinking;
        }
        await this.record(entry, 'before_iteration', current, 'transform', 'ok', undefined, {
          model: transform.model,
          thinking: transform.thinking,
          snapshotPluginIds: snapshotContributions.map((contribution) => contribution.pluginId),
        });
      } catch (error) {
        await this.record(entry, 'before_iteration', current, 'transform', this.outcome(error), failureMessage(error));
        throw error;
      }
    }
    let final: HookVote = { decision: 'allow' };
    const finalEvent = {
      ...event,
      model: transform.model ?? event.model,
      thinking: transform.thinking ?? event.thinking,
    };
    for (const entry of this.entries('before_iteration', 'vote')) {
      const vote = await this.invokeVote(entry, finalEvent);
      if (vote.decision === 'deny') final = vote;
      else if (vote.decision === 'require_approval') {
        final = { decision: 'deny', pluginId: entry.pluginId, reason: 'before_iteration does not support approval votes' };
        await this.record(entry, 'before_iteration', finalEvent, 'vote', 'denied', final.reason);
      }
    }
    return { transform, snapshotContributions: [...snapshotContributions], vote: final };
  }

  async approveToolCall(event: HookToolEvent, request: Readonly<HookToolApproval>, pluginId: string): Promise<HitlOutcome> {
    return this.host.approveToolCall(event, request, pluginId);
  }

  private entries(name: PluginHookName, phase: RegisteredHook['phase']): RegisteredHook[] {
    return this.host.getHooks()
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.hookName === name && entry.phase === phase)
      .sort((a, b) => b.entry.priority - a.entry.priority || a.index - b.index)
      .map(({ entry }) => entry);
  }

  private async invokeVote(entry: RegisteredHook, event: ExtensionHookContext, details?: Record<string, unknown>): Promise<HookVote> {
    let vote: HookVote;
    let failure: 'error' | 'timeout' | 'aborted' | undefined;
    try {
      const result = await this.invoke(entry, event);
      if (result !== undefined && result !== null && !isVote(result)) {
        throw new Error('Vote hook must return {decision}');
      }
      vote = result === undefined || result === null
        ? { decision: 'allow', pluginId: entry.pluginId }
        : { ...result, pluginId: entry.pluginId };
    } catch (error) {
      // Fail-closed to deny, but the audit must not relabel a handler failure as a
      // human/policy deny — record the real cause class and keep the message.
      failure = this.outcome(error);
      vote = { decision: 'deny', pluginId: entry.pluginId, reason: failureMessage(error) };
    }
    await this.record(entry, entry.hookName, event, 'vote',
      failure ?? (vote.decision === 'deny' ? 'denied' : 'ok'), vote.reason, details);
    return vote;
  }

  private transformEvent<K extends PluginHookName>(name: K, event: HookEvent<K>, value: unknown): HookEvent<K> {
    if (name === 'agent_turn_prepare') return { ...event, prompt: value as string } as HookEvent<K>;
    if (name === 'before_model_resolve') return { ...event, current: value } as HookEvent<K>;
    if (name === 'before_agent_finalize') return { ...event, reply: value as Message } as HookEvent<K>;
    throw new Error(`${name} is not a Transform hook`);
  }

  private transformedValue(name: PluginHookName, previous: unknown, next: unknown): unknown {
    if (name === 'agent_turn_prepare') {
      if (typeof next !== 'string') throw new Error('agent_turn_prepare must return a prompt string');
      return next;
    }
    if (name === 'before_agent_finalize') {
      const value = typeof next === 'string'
        ? { ...(previous as Message), content: next }
        : next;
      if (!isParams(value) || (value as unknown as Message).role !== 'assistant') {
        throw new Error('before_agent_finalize must return an assistant Message or string');
      }
      const message = value as unknown as Message;
      if (message.toolCalls?.length) {
        throw new Error('before_agent_finalize must not add toolCalls to the final reply');
      }
      if (typeof message.content !== 'string' && !Array.isArray(message.content)) {
        throw new Error('before_agent_finalize must keep text or block-array content');
      }
      return value;
    }
    if (name === 'before_model_resolve') {
      if (!isParams(next) || typeof next.provider !== 'string' || !next.provider ||
        typeof next.model !== 'string' || !next.model) {
        throw new Error('before_model_resolve must return non-empty provider/model strings');
      }
      return { provider: next.provider, model: next.model };
    }
    throw new Error(`${name} is not a Transform hook`);
  }

  private async invoke(entry: RegisteredHook, event: ExtensionHookContext): Promise<unknown> {
    const parent = event.signal;
    if (parent?.aborted) throw new Error('Hook aborted before handler start');
    const controller = new AbortController();
    const timeoutMs = this.host.getPluginConfig(entry.pluginId)?.hooks?.timeouts?.[entry.hookName]
      ?? this.host.getPluginConfig(entry.pluginId)?.hooks?.timeoutMs
      ?? entry.timeoutMs ?? 30_000;
    let timedOut = false;
    let settled = false;
    const abort = (): void => controller.abort(parent?.reason);
    parent?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Hook handler timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      return await new Promise((resolve, reject) => {
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };
        controller.signal.addEventListener('abort', () => {
          finish(() => reject(timedOut
            ? new Error(`Hook handler timed out after ${timeoutMs}ms`)
            : new Error('Hook handler aborted')));
        }, { once: true });
        Promise.resolve().then(() => entry.handler({ ...event, signal: controller.signal } as never)).then(
          (result) => finish(() => resolve(result)),
          (error) => finish(() => reject(error)),
        );
      });
    } finally {
      settled = true;
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    }
  }

  private outcome(error: unknown): 'error' | 'timeout' | 'aborted' {
    const message = failureMessage(error);
    return message.includes('timed out') ? 'timeout' : message.includes('aborted') ? 'aborted' : 'error';
  }

  private async execute<K extends PluginHookName>(
    entry: RegisteredHook,
    event: HookEvent<K>,
    phase: 'observe' | 'collect',
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      await fn();
      await this.record(entry, entry.hookName, event, phase, 'ok');
    } catch (error) {
      // Observe and optional Collect explicitly fail open; their audit records the failure.
      await this.record(entry, entry.hookName, event, phase, this.outcome(error), failureMessage(error));
    }
  }

  private async record<K extends PluginHookName>(
    entry: RegisteredHook,
    name: K,
    event: HookEvent<K>,
    phase: HookAuditRecord['phase'],
    outcome: HookAuditRecord['outcome'],
    reason?: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.host.recordHook({
        pluginId: entry.pluginId,
        hookName: name,
        phase,
        outcome,
        sessionId: event.sessionId,
        agentId: event.agentId,
        ...(event.runId === undefined ? {} : { runId: event.runId }),
        ...(event.principal === undefined ? {} : { principal: event.principal }),
        ...(reason === undefined ? {} : { reason }),
        ...(details === undefined ? {} : { details }),
      });
    } catch (error) {
      // Audit is an observability sink here, not an authorization grant; retain the original decision.
      console.error(`[PluginHookAdapter] audit failed for ${entry.pluginId}/${name}:`, error);
    }
  }
}
