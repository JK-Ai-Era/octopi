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
  private inflight = new Map<string, Promise<boolean>>();

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
   * Concurrent callers for the same key share one `ask()`.
   */
  resolve(options: {
    channel: HitlChannel;
    key: string;
    sessionId?: string;
    agentId?: string;
    ask: () => Promise<HitlDecision>;
  }): Promise<boolean> {
    const inflightKey = options.sessionId
      ? sessionKey(options.channel, options.sessionId, options.key)
      : options.agentId
        ? alwaysKey(options.agentId, options.channel, options.key)
        : channelKey(options.channel, options.key);
    const existing = this.inflight.get(inflightKey);
    if (existing) return existing;

    const pending = this.resolveUncached(options).finally(() => {
      this.inflight.delete(inflightKey);
    });
    this.inflight.set(inflightKey, pending);
    return pending;
  }

  private async resolveUncached(options: {
    channel: HitlChannel;
    key: string;
    sessionId?: string;
    agentId?: string;
    ask: () => Promise<HitlDecision>;
  }): Promise<boolean> {
    const cached = this.get(options.channel, options.key, {
      sessionId: options.sessionId,
      agentId: options.agentId,
    });
    if (cached === 'approve') return true;

    let decision: HitlDecision;
    try {
      decision = await options.ask();
    } catch {
      // 审批通道异常按拒绝处理（fail-safe）；此处吞掉仅因「异常不改变不放行」结论
      return false;
    }

    if (
      decision === 'approve' ||
      decision === 'approve_session' ||
      decision === 'approve_always'
    ) {
      this.remember(decision, options.channel, options.key, {
        sessionId: options.sessionId,
        agentId: options.agentId,
      });
      return true;
    }
    return false;
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
  ask: () => Promise<HitlDecision>;
}): Promise<boolean> {
  const cache = options.cache ?? defaultHitlCache;
  return cache.resolve(options);
}
