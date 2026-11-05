import type { CompactEngine, CompactOptions, CompactOutcome } from '../../../context/capabilities/compact/index.js';
import { getRunScope } from '../../../run/run-scope.js';
import { HeuristicTokenEstimator } from '../../../context/token-estimator.js';
import type { ExtensionHookPort, HookCompactionEvent } from './types.js';

/** Keep Hook admission outside compaction algorithms and the E4 state transition. */
export class HookedCompactEngine implements CompactEngine {
  constructor(
    private readonly inner: CompactEngine,
    private readonly port: ExtensionHookPort,
    private readonly identity: { sessionId: string; agentId?: string },
  ) {}

  /** Text compaction is not a Session compaction event. */
  compactText(text: string, options?: CompactOptions): Promise<CompactOutcome> {
    return this.inner.compactText(text, options);
  }

  /** Vote before any summary work; observe the actual success/degraded/fresh result. */
  async compactMessages(messages: Parameters<CompactEngine['compactMessages']>[0], options: CompactOptions): Promise<CompactOutcome> {
    const scope = getRunScope();
    const event: HookCompactionEvent = {
      // Explicit caller identity wins: a manual compaction must not be attributed
      // to whatever Run happens to hold the async context.
      sessionId: options.sessionId ?? scope?.sessionId ?? this.identity.sessionId,
      agentId: options.agentId ?? scope?.agentId ?? this.identity.agentId ?? 'default',
      ...(scope?.runId === undefined ? {} : { runId: scope.runId }),
      ...(scope?.principal === undefined ? {} : { principal: scope.principal }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      mode: options.mode ?? 'auto',
      previousSummary: options.previousSummary,
    };
    const vote = await this.port.vote('before_compaction', event);
    if (vote.decision !== 'allow') {
      return {
        ok: true,
        summary: options.previousSummary,
        compacted: false,
        reason: `denied:${vote.reason ?? 'before_compaction'}`,
        tokensBefore: options.estimator?.estimateMessages(messages)
          ?? new HeuristicTokenEstimator().estimateMessages(messages),
        summarizeAttempted: false,
        fresh: false,
        view: [...messages],
      };
    }
    try {
      const outcome = await this.inner.compactMessages(messages, options);
      await this.port.observe('after_compaction', {
        ...event,
        coveredMessageCount: options.foldRange?.replacedCount,
        compacted: outcome.compacted,
        fresh: outcome.fresh,
        reason: outcome.reason,
      });
      return outcome;
    } catch (error) {
      await this.port.observe('after_compaction', {
        ...event,
        compacted: false,
        fresh: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
