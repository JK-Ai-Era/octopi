/**
 * HITL decision cache (SEC-7 single model).
 *
 * Hosts only *express* a {@link HitlDecision}; the engine remembers
 * `approve_session` / `approve_always` so the confirm hook is not re-entered.
 * `deny` and one-shot `approve` are never cached.
 *
 * Scoping (narrow-only):
 * - `approve_session`  → per `sessionId` + tool/effect key
 * - `approve_always`   → per `agentId` + tool/effect key（agent 信任级不同则分桶）
 * Missing scope id → degrade to one-shot (never over-grant).
 */

import type { HitlDecision } from '@octopi-agent/core/types/tools.js';

/** Which confirm surface produced the decision */
export type HitlChannel = 'high_risk' | 'effect';

/** Cached scope of a remembered approval */
export type HitlCacheScope = 'session' | 'always';

/** 非人工拒绝来源（人工决策不带此标注）；用于错误面与审计如实归因 */
export type HitlDenyReason = 'no_channel' | 'channel_error' | 'aborted' | 'cancelled';

/** ask 回调结果：裸决策或带来源/归因标注（同 key 并发合流共享） */
export interface HitlAskResult {
  decision: HitlDecision;
  /** 确认窗到期（超时=拒绝，T1 硬约束） */
  timedOut?: boolean;
  /** 非人工拒绝来源 */
  denyReason?: HitlDenyReason;
  /** 拒绝来源细节（如宿主 reason 原文） */
  denyDetail?: string;
  /** 确认人署名（随 channel 判读可信度） */
  approver?: string;
  /** 确认通道 */
  channel?: string;
}

/** HITL 决策结果（同 key 并发合流共享同一结果对象，杜绝各说各话） */
export interface HitlOutcome {
  allowed: boolean;
  decision: HitlDecision;
  timedOut: boolean;
  denyReason?: HitlDenyReason;
  denyDetail?: string;
  approver?: string;
  channel?: string;
}

interface SessionEntry {
  decision: 'approve';
  expiresAt: number;
}

function channelKey(channel: HitlChannel, key: string): string {
  return `${channel}\0${key}`;
}

function sessionKey(channel: HitlChannel, sessionId: string, key: string): string {
  return `${sessionId}\0${channelKey(channel, key)}`;
}

/** always is agent-scoped: different trust domains do not share grants */
function alwaysKey(agentId: string, channel: HitlChannel, key: string): string {
  return `${agentId}\0${channelKey(channel, key)}`;
}

/**
 * In-memory HITL approval cache.
 *
 * Session-scoped approvals are keyed by `sessionId` and expire after
 * {@link HitlDecisionCache.sessionTtlMs}. Always-scoped approvals are keyed by
 * `agentId` and live for the process lifetime (not persisted).
 */
export class HitlDecisionCache {
  /** Session-scope TTL in ms (default 24h) */
  readonly sessionTtlMs: number;
  private session = new Map<string, SessionEntry>();
  private always = new Map<string, 'approve'>();
  /** In-flight resolves, so concurrent same-key confirms share one ask() */
  private inflight = new Map<string, Promise<HitlOutcome>>();

  /**
   * @param sessionTtlMs - how long `approve_session` stays valid (default 24h)
   */
  constructor(sessionTtlMs = 24 * 60 * 60 * 1000) {
    this.sessionTtlMs = sessionTtlMs;
  }

  /**
   * Look up a remembered approval.
   *
   * @param channel - high_risk | effect
   * @param key - tool name or effect kind
   * @param options - sessionId (session scope) and/or agentId (always scope)
   * @returns `'approve'` if cached, otherwise `null`
   */
  get(
    channel: HitlChannel,
    key: string,
    options: { sessionId?: string; agentId?: string } = {},
  ): 'approve' | null {
    const { sessionId, agentId } = options;
    if (agentId) {
      const always = this.always.get(alwaysKey(agentId, channel, key));
      if (always) return always;
    }
    if (!sessionId) return null;
    const entry = this.session.get(sessionKey(channel, sessionId, key));
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.session.delete(sessionKey(channel, sessionId, key));
      return null;
    }
    return entry.decision;
  }

  /**
   * Remember an approval decision. Only `approve_session` / `approve_always`
   * are stored; `deny` and one-shot `approve` are ignored.
   *
   * `approve_session` requires `sessionId`; `approve_always` requires `agentId`.
   * Missing scope id → silently one-shot (fail-safe, never over-grant).
   *
   * @param decision - host decision
   * @param channel - high_risk | effect
   * @param key - tool name or effect kind
   * @param options - sessionId and/or agentId
   */
  remember(
    decision: HitlDecision,
    channel: HitlChannel,
    key: string,
    options: { sessionId?: string; agentId?: string } = {},
  ): void {
    const { sessionId, agentId } = options;
    if (decision === 'approve_always') {
      if (!agentId) return;
      this.always.set(alwaysKey(agentId, channel, key), 'approve');
      return;
    }
    if (decision === 'approve_session') {
      if (!sessionId) return;
      this.session.set(sessionKey(channel, sessionId, key), {
        decision: 'approve',
        expiresAt: Date.now() + this.sessionTtlMs,
      });
    }
  }

  /**
   * Drop session-scoped approvals for one session (always-scope kept).
   *
   * @param sessionId - session to clear
   */
  clearSession(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const k of this.session.keys()) {
      if (k.startsWith(prefix)) this.session.delete(k);
    }
  }

  /** Drop always-scoped approvals for one agent. */
  clearAgent(agentId: string): void {
    const prefix = `${agentId}\0`;
    for (const k of this.always.keys()) {
      if (k.startsWith(prefix)) this.always.delete(k);
    }
  }

  /** Drop all cached approvals (tests / host reset). */
  clear(): void {
    this.session.clear();
    this.always.clear();
    this.inflight.clear();
  }

  /**
   * Resolve through cache + host hook with in-flight de-dup.
   * Concurrent callers for the same key share one `ask()` and one outcome object
   * (decision + timedOut + attribution — 合流者不得各自编造拒绝来源).
   */
  resolve(options: {
    channel: HitlChannel;
    key: string;
    sessionId?: string;
    agentId?: string;
    ask: () => Promise<HitlDecision | HitlAskResult>;
  }): Promise<boolean> {
    return this.resolveOutcome(options).then((outcome) => outcome.allowed);
  }

  /** 同 {@link resolve}，但回传完整结果（timedOut / 拒绝来源 / 归因），供错误面与审计口径一致。 */
  resolveOutcome(options: {
    channel: HitlChannel;
    key: string;
    sessionId?: string;
    agentId?: string;
    ask: () => Promise<HitlDecision | HitlAskResult>;
  }): Promise<HitlOutcome> {
    const inflightKey = options.sessionId
      ? sessionKey(options.channel, options.sessionId, options.key)
      : options.agentId
        ? alwaysKey(options.agentId, options.channel, options.key)
        : channelKey(options.channel, options.key);
    const existing = this.inflight.get(inflightKey);
    if (existing) return existing;

    const pending = this.resolveOutcomeUncached(options).finally(() => {
      this.inflight.delete(inflightKey);
    });
    this.inflight.set(inflightKey, pending);
    return pending;
  }

  private async resolveOutcomeUncached(options: {
    channel: HitlChannel;
    key: string;
    sessionId?: string;
    agentId?: string;
    ask: () => Promise<HitlDecision | HitlAskResult>;
  }): Promise<HitlOutcome> {
    const cached = this.get(options.channel, options.key, {
      sessionId: options.sessionId,
      agentId: options.agentId,
    });
    if (cached === 'approve') {
      return { allowed: true, decision: 'approve', timedOut: false };
    }

    let outcome: HitlOutcome;
    try {
      const raw = await options.ask();
      const result: HitlAskResult = typeof raw === 'string' ? { decision: raw } : raw;
      outcome = {
        allowed:
          result.decision === 'approve' ||
          result.decision === 'approve_session' ||
          result.decision === 'approve_always',
        decision: result.decision,
        timedOut: result.timedOut ?? false,
        ...(result.denyReason !== undefined ? { denyReason: result.denyReason } : {}),
        ...(result.denyDetail !== undefined ? { denyDetail: result.denyDetail } : {}),
        ...(result.approver !== undefined ? { approver: result.approver } : {}),
        ...(result.channel !== undefined ? { channel: result.channel } : {}),
      };
    } catch {
      // 审批通道异常按拒绝处理（fail-safe）；吞掉异常体只因「不放行」结论不变——
      // 但来源如实标注 channel_error，异常绝不伪装成人工拒绝
      outcome = { allowed: false, decision: 'deny', timedOut: false, denyReason: 'channel_error' };
    }

    if (outcome.allowed) {
      this.remember(
        outcome.decision as 'approve' | 'approve_session' | 'approve_always',
        options.channel,
        options.key,
        {
          sessionId: options.sessionId,
          agentId: options.agentId,
        },
      );
    }
    return outcome;
  }
}

/** Process-wide default cache (keys include sessionId / agentId). */
export const defaultHitlCache = new HitlDecisionCache();

/**
 * Resolve a HITL confirm through cache + host hook (SEC-7).
 *
 * Fail-closed: missing hook, thrown error, or non-approve decision → false.
 * Concurrent same-key callers share one host prompt (in-flight de-dup).
 *
 * @param options - cache, channel, key, sessionId, agentId, and the host ask callback
 * @returns true only when the call is approved (cached or live)
 */
export async function resolveHitlDecision(options: {
  cache?: HitlDecisionCache;
  channel: HitlChannel;
  key: string;
  sessionId?: string;
  agentId?: string;
  ask: () => Promise<HitlDecision | HitlAskResult>;
}): Promise<boolean> {
  return (await resolveHitlOutcome(options)).allowed;
}

/**
 * 同 {@link resolveHitlDecision}，但回传完整结果（timedOut / 拒绝来源 / 归因）——
 * 供调用方把错误面标注得与审计一致：超时 ≠ 人工拒绝 ≠ 通道故障，三者不得混为一谈。
 *
 * @param options - 同 resolveHitlDecision
 * @returns 完整决策结果（同 key 并发合流共享同一对象）
 */
export async function resolveHitlOutcome(options: {
  cache?: HitlDecisionCache;
  channel: HitlChannel;
  key: string;
  sessionId?: string;
  agentId?: string;
  ask: () => Promise<HitlDecision | HitlAskResult>;
}): Promise<HitlOutcome> {
  const cache = options.cache ?? defaultHitlCache;
  return cache.resolveOutcome(options);
}
