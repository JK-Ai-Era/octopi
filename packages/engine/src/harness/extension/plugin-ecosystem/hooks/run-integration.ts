import type { Message } from '@octopi-agent/core/types.js';
import type {
  AgentContext,
  AgentLoopConfig,
  BeforeToolCallContext,
  LoopToolResult,
  StepContext,
} from '@octopi-agent/core/loop/types.js';
import { getTextContent } from '@octopi-agent/core/types.js';
import { getRunScope } from '../../../run/run-scope.js';
import type { RunScope } from '../../../run/run-scope.js';
import type { ResolvedModel } from '../../../run/model/types.js';
import type { HarnessLoopEvent } from '../../../run/reliability/harness-events.js';
import { HookDeniedError } from './adapter.js';
import { ExtensionTerminalError, shouldAbortWithoutRetry, unwrapExtensionTerminalError } from './policy-error.js';
import type {
  ExtensionHookContext,
  ExtensionHookPort,
  HookAfterIterationEvent,
  HookIterationEvent,
  HookToolEvent,
} from './types.js';

export interface AgentExtensionHookIntegration {
  prepareToolArguments: AgentLoopConfig['prepareToolArguments'];
  onToolCallComplete: AgentLoopConfig['onToolCallComplete'];
  beforeStep: AgentLoopConfig['beforeStep'];
  onStepComplete: AgentLoopConfig['onStepComplete'];
}

/** Per-Run mutable projections shared with Core's existing config callbacks. */
export class AgentExtensionHookState {
  readonly originalToolParams = new WeakMap<BeforeToolCallContext['toolCall'], Readonly<Record<string, unknown>>>();
  private iterationSnapshots = new Map<number, { contributions: Array<{ pluginId: string; text: string }>; tokenBudget: number }>();
  private readonly originalOnStepComplete: AgentLoopConfig['onStepComplete'];
  private readonly originalBeforeStep: AgentLoopConfig['beforeStep'];
  private readonly originalTransformLlmMessages: AgentLoopConfig['transformLlmMessages'];

  constructor(
    private readonly port: ExtensionHookPort,
    private readonly scope: () => RunScope,
    config: AgentLoopConfig,
  ) {
    this.originalOnStepComplete = config.onStepComplete;
    this.originalBeforeStep = config.beforeStep;
    this.originalTransformLlmMessages = config.transformLlmMessages;
  }

  /** Project only the normalized Provider request, never the Run's message workspace. */
  async transformLlmMessages(messages: import('@octopi-agent/core/interfaces/model-provider.js').LLMMessage[]): Promise<import('@octopi-agent/core/interfaces/model-provider.js').LLMMessage[]> {
    const index = Math.max(0, (this.scope().iteration ?? 1) - 1);
    const snapshot = this.iterationSnapshots.get(index);
    const current = this.originalTransformLlmMessages
      ? await this.originalTransformLlmMessages(messages)
      : messages;
    if (!snapshot) return current;
    const { projectPluginIterationSnapshot } = await import('./iteration-snapshot.js');
    return projectPluginIterationSnapshot(current, snapshot.contributions, snapshot.tokenBudget);
  }

  callbacks(): AgentExtensionHookIntegration {
    return {
      prepareToolArguments: async (ctx, signal) => this.prepareToolArguments(ctx, signal),
      onToolCallComplete: async (ctx) => this.onToolCallComplete(ctx),
      beforeStep: async (ctx) => this.beforeStep(ctx),
      onStepComplete: async (ctx) => {
        // Finalize first: empty-reply/planning detection, step summaries, events and
        // persistence must all see the finalized reply — not the raw model output.
        await this.onStepComplete(ctx);
        await this.originalOnStepComplete?.(ctx);
      },
    };
  }

  private context(signal?: AbortSignal): ExtensionHookContext {
    const scope = this.scope();
    return {
      sessionId: scope.sessionId,
      agentId: scope.agentId,
      ...(scope.runId === undefined ? {} : { runId: scope.runId }),
      ...(scope.principal === undefined ? {} : { principal: scope.principal }),
      ...(signal === undefined ? {} : { signal }),
    };
  }

  private async prepareToolArguments(ctx: BeforeToolCallContext, signal?: AbortSignal): Promise<unknown> {
    // No registered handler → nothing to attribute; skip event construction and
    // the Run-identity requirement (direct Agent.run() must keep working idle).
    if (!this.port.hasHooks('before_tool_call')) return ctx.args;
    const scope = this.scope();
    if (!scope.runId) throw new Error('before_tool_call requires a Host Run identity');
    if (ctx.args === null || typeof ctx.args !== 'object' || Array.isArray(ctx.args)) return ctx.args;
    const original = ctx.args as Record<string, unknown>;
    const result = await this.port.transformBeforeToolCall({
      ...this.context(signal),
      runId: scope.runId,
      toolName: ctx.toolCall.name,
      call: ctx.toolCall,
      params: original,
    });
    this.originalToolParams.set(ctx.toolCall, { ...original });
    const value = result.value;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      // Fail-closed for this call: tool validation, SecurityGuard and audit all
      // inspect a plain parameter record; a non-record transform hides the payload.
      throw new Error('before_tool_call transform must return a plain object of parameters');
    }
    return value;
  }

  private async onToolCallComplete(ctx: Parameters<NonNullable<AgentLoopConfig['onToolCallComplete']>>[0]): Promise<void> {
    if (!this.port.hasHooks('after_tool_call')) return;
    const scope = this.scope();
    if (!scope.runId) return;
    const params = (ctx.args ?? {}) as Record<string, unknown>;
    await this.port.observe('after_tool_call', {
      ...this.context(),
      runId: scope.runId,
      call: ctx.toolCall,
      originalParams: this.originalToolParams.get(ctx.toolCall) ?? params,
      params,
      result: ctx.result as unknown as import('@octopi-agent/core/types.js').ToolResult,
      ...(ctx.result.isError ? { error: getTextContent(String(ctx.result.content ?? '')) } : {}),
    });
  }

  private async beforeStep(ctx: Parameters<NonNullable<AgentLoopConfig['beforeStep']>>[0]): Promise<import('@octopi-agent/core/loop/types.js').StepUpdate | undefined> {
    try {
      return await this.prepareStep(ctx);
    } catch (error) {
      throw new ExtensionTerminalError(error);
    }
  }

  private async prepareStep(ctx: Parameters<NonNullable<AgentLoopConfig['beforeStep']>>[0]): Promise<import('@octopi-agent/core/loop/types.js').StepUpdate | undefined> {
    const originalUpdate = await this.originalBeforeStep?.(ctx);
    const scope = this.scope();
    // Iteration bookkeeping also serves after_iteration observations: keep it
    // outside the before_iteration short-circuit or the counter stays at 0.
    scope.iteration = ctx.iteration + 1;
    if (!this.port.hasHooks('before_iteration')) return originalUpdate;
    const currentModel = scope.resolvedModel;
    if (!scope.runId || !currentModel) throw new Error('before_iteration requires a resolved Host model and Run identity');
    const result = await this.port.beforeIteration({
      ...this.context(),
      runId: scope.runId,
      iteration: ctx.iteration,
      messages: ctx.context.messages,
      model: { provider: currentModel.providerName, model: currentModel.modelName },
      thinking: scope.thinkingLevel,
    });
    if (result.vote.decision !== 'allow') {
      throw new HookDeniedError(result.vote, 'before_iteration');
    }
    let resolved = currentModel;
    if (result.transform.model) {
      if (!scope.resolveConfiguredModel) {
        throw new Error('before_iteration model Transform has no Host model resolver');
      }
      const next = await scope.resolveConfiguredModel(result.transform.model);
      if (!next) throw new Error(`before_iteration selected an unconfigured model: ${result.transform.model.provider}/${result.transform.model.model}`);
      resolved = next;
    }
    scope.resolvedModel = resolved;
    // Consensus transform: undefined means "no opinion", never "clear".
    if (result.transform.thinking !== undefined) scope.thinkingLevel = result.transform.thinking;
    if (resolved !== currentModel) {
      const { updateResolvedModel } = await import('../../../run/model/run-scope.js');
      updateResolvedModel(resolved);
    }
    if (result.transform.snapshot !== undefined) {
      this.iterationSnapshots.set(ctx.iteration, {
        contributions: result.snapshotContributions.map((contribution) => ({
          pluginId: contribution.pluginId,
          text: contribution.value,
        })),
        tokenBudget: Math.max(1, Math.min(
          scope.extensionSnapshotBudgetTokens ?? 4096,
          Math.floor((resolved.contextWindow ?? 8192) * 0.1),
        )),
      });
    } else {
      this.iterationSnapshots.delete(ctx.iteration);
    }
    return {
      ...originalUpdate,
      ...(resolved === currentModel ? {} : { model: resolved.provider }),
      ...(result.transform.thinking === undefined ? {} : { thinkingLevel: result.transform.thinking }),
    };
  }

  private async onStepComplete(ctx: StepContext): Promise<void> {
    const wantsFinalize = this.port.hasHooks('before_agent_finalize');
    const wantsObserve = this.port.hasHooks('after_iteration');
    if (!wantsFinalize && !wantsObserve) return;
    const scope = this.scope();
    // Finalize needs only the Run identity; after_iteration additionally reports
    // the resolved model — separate gates so a missing model never silently
    // swallows a registered finalize.
    if (!scope.runId) return;
    if (wantsFinalize && !ctx.message.toolCalls?.length) {
      const transformed = await this.port.transform('before_agent_finalize', {
        ...this.context(),
        runId: scope.runId,
        reply: ctx.message,
      }, ctx.message);
      const next = transformed.value as Message;
      if (ctx.context.messages.lastIndexOf(ctx.message) < 0) {
        throw new Error('before_agent_finalize candidate is absent from RunScope messages');
      }
      // Mutate in place only: the message store slot, the event copy and the loop's
      // message must stay one identity. Replacing the slot with the plugin's object
      // forks persistence from events and drops timestamp/metadata on the stored side.
      Object.assign(ctx.message, next);
    }
    if (!wantsObserve || !scope.resolvedModel) return;
    await this.port.observe('after_iteration', {
      ...this.context(),
      runId: scope.runId,
      iteration: Math.max(0, (scope.iteration ?? 1) - 1),
      messages: ctx.context.messages,
      model: { provider: scope.resolvedModel.providerName, model: scope.resolvedModel.modelName },
      ...(scope.thinkingLevel === undefined ? {} : { thinking: scope.thinkingLevel }),
      assistantMessage: ctx.context.messages.find((message) => message === ctx.message) ?? ctx.message,
      toolResults: ctx.toolResults as unknown as import('@octopi-agent/core/types.js').ToolResult[],
    });
  }
}

/** Enriches Loop config with per-Run hook callbacks; no plugin type enters Core. */
export function integrateAgentHooks(
  port: ExtensionHookPort | undefined,
  config: AgentLoopConfig,
  scope: () => RunScope,
): AgentExtensionHookState | undefined {
  if (!port) return undefined;
  return new AgentExtensionHookState(port, scope, config);
}

/** Host Run-level Vote/Override/Observe, outside the reliability loop. */
export async function* withAgentRunHooks(
  port: ExtensionHookPort | undefined,
  scope: RunScope,
  context: AgentContext,
  signal: AbortSignal | undefined,
  gen: AsyncGenerator<HarnessLoopEvent>,
): AsyncGenerator<HarnessLoopEvent> {
  if (!port) {
    yield* gen;
    return;
  }
  const startedAt = Date.now();
  const runId = scope.runId ?? `unidentified:${scope.sessionId}:${scope.agentId}`;
  const base: ExtensionHookContext = {
    sessionId: scope.sessionId,
    agentId: scope.agentId,
    runId,
    ...(scope.principal === undefined ? {} : { principal: scope.principal }),
    ...(signal === undefined ? {} : { signal }),
  };
  let reason = 'completed';
  let success = true;
  let failure: unknown;
  let iterations = 0;
  try {
    const prompt = scope.prompt ?? getTextContent([...context.messages].reverse().find((message) => message.role === 'user')?.content ?? '');
    const runEvent = { ...base, runId, prompt, messages: context.messages };
    const vote = await port.vote('before_agent_run', runEvent);
    if (vote.decision !== 'allow') throw new HookDeniedError(vote, 'before_agent_run');
    const override = await port.override('before_agent_reply', runEvent);
    if (override) {
      const finalized = await port.transform('before_agent_finalize', { ...base, runId, reply: override }, override) as { value: Message };
      const reply: Message = {
        ...finalized.value,
        agentId: finalized.value.agentId ?? scope.agentId,
        timestamp: finalized.value.timestamp ?? Date.now(),
      };
      context.messages.push(reply);
      yield { type: 'agent_start', timestamp: Date.now() };
      yield { type: 'step_start', timestamp: Date.now() };
      yield { type: 'assistant_message', message: reply, timestamp: Date.now() };
      yield { type: 'step_end', hasToolCalls: false, phase: 'final' };
      iterations = 1;
      yield { type: 'agent_end', reason: 'completed', timestamp: Date.now() };
    } else {
      for await (const event of gen) {
        if (event.type === 'agent_end') {
          const terminal = shouldAbortWithoutRetry(event.error);
          // failure first: the denied remap below must see the unwrapped cause.
          failure = terminal ? unwrapExtensionTerminalError(event.error) : event.error;
          reason = failure instanceof HookDeniedError && event.reason === 'error' ? 'denied' : event.reason;
          success = isSuccessfulRunEnd(reason);
          if (terminal) {
            yield { ...event, error: failure };
            break;
          }
        }
        if (event.type === 'step_end') iterations += 1;
        yield event;
      }
    }
  } catch (error) {
    failure = unwrapExtensionTerminalError(error);
    reason = failure instanceof HookDeniedError ? 'denied' : 'error';
    success = isSuccessfulRunEnd(reason);
    yield { type: 'agent_end', reason: 'error', timestamp: Date.now(), error: failure };
  } finally {
    const messages = context.messages;
    await port.observe('loop_end', {
      ...base,
      runId,
      messages,
      durationMs: Date.now() - startedAt,
      reason,
      success,
      ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : String(failure) }),
      iterations,
      response: getTextContent([...messages].reverse().find((message) => message.role === 'assistant' && !message.toolCalls?.length)?.content ?? ''),
    });
    await observeRunEnd(port, base, messages, startedAt, reason, success, failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : undefined);
  }
}

/**
 * Single success formula for loop_end and agent_end observations: clean terminal
 * ends (completed / should_stop) succeed; aborted / error / denied do not. The
 * Runner treats only `error` as a failed Run and `should_stop` as an intentional
 * stop, so a clean stop is not a failure. `reason` always carries the exact cause.
 */
function isSuccessfulRunEnd(reason: string): boolean {
  return reason === 'completed' || reason === 'should_stop';
}

async function observeRunEnd(
  port: ExtensionHookPort,
  base: ExtensionHookContext,
  messages: readonly Message[],
  startedAt: number,
  reason: string,
  success: boolean,
  error?: string,
): Promise<void> {
  await port.observe('agent_end', {
    ...base,
    runId: base.runId ?? 'unknown',
    messages,
    durationMs: Date.now() - startedAt,
    reason,
    success,
    ...(error === undefined ? {} : { error }),
  });
}

/** Build the Host Run tool Vote after SecurityGuard and before raw execution. */
export async function voteAgentToolCall(
  port: ExtensionHookPort | undefined,
  ctx: BeforeToolCallContext,
  originalParams: WeakMap<BeforeToolCallContext['toolCall'], Readonly<Record<string, unknown>>>,
  signal?: AbortSignal,
): Promise<import('@octopi-agent/core/loop/types.js').BeforeToolCallResult | undefined> {
  if (!port || ctx.args === null || typeof ctx.args !== 'object' || Array.isArray(ctx.args)) return undefined;
  const scope = getRunScope();
  if (!scope?.runId) throw new Error('before_tool_call Vote requires a Host Run identity');
  const event: HookToolEvent = {
    sessionId: scope.sessionId,
    agentId: scope.agentId,
    runId: scope.runId,
    ...(scope.principal === undefined ? {} : { principal: scope.principal }),
    ...(signal === undefined ? {} : { signal }),
    toolName: ctx.toolCall.name,
    call: ctx.toolCall,
    params: ctx.args as Record<string, unknown>,
  };
  const vote = await port.voteBeforeToolCall(event, originalParams.get(ctx.toolCall) ?? event.params);
  if (vote.decision === 'allow') return undefined;
  return {
    block: true,
    reason: vote.reason ?? `Plugin hook denied ${ctx.toolCall.name}`,
  };
}
