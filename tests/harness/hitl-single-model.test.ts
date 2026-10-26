/**
 * SEC-7 HITL 单模型 — HitlDecision + HitlDecisionCache + resolveHitlDecision
 */
import { describe, it, expect, vi } from 'vitest';

import {
  HitlDecisionCache,
  resolveHitlDecision,
} from '@octopi-agent/engine/harness/governance/human-in-the-loop/decision-cache.js';
import { gateEffect } from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';
import type { ConfirmEffect } from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';

describe('HitlDecisionCache', () => {
  it('does not cache one-shot approve or deny', () => {
    const cache = new HitlDecisionCache();
    cache.remember('approve', 'high_risk', 'shell', { sessionId: 's1', agentId: 'a1' });
    cache.remember('deny', 'high_risk', 'shell', { sessionId: 's1', agentId: 'a1' });
    expect(cache.get('high_risk', 'shell', { sessionId: 's1', agentId: 'a1' })).toBeNull();
  });

  it('caches approve_session per session', () => {
    const cache = new HitlDecisionCache();
    cache.remember('approve_session', 'high_risk', 'shell', { sessionId: 's1' });
    expect(cache.get('high_risk', 'shell', { sessionId: 's1' })).toBe('approve');
    expect(cache.get('high_risk', 'shell', { sessionId: 's2' })).toBeNull();
  });

  it('caches approve_always per agent (not across agents)', () => {
    const cache = new HitlDecisionCache();
    cache.remember('approve_always', 'effect', 'shell', { agentId: 'agent-a' });
    expect(cache.get('effect', 'shell', { agentId: 'agent-a' })).toBe('approve');
    expect(cache.get('effect', 'shell', { agentId: 'agent-b' })).toBeNull();
    // 无 agentId 不匹配任何 always（防串桶）
    expect(cache.get('effect', 'shell')).toBeNull();
    // 同 agent 跨 session 有效
    expect(cache.get('effect', 'shell', { agentId: 'agent-a', sessionId: 's9' })).toBe('approve');
  });

  it('approve_always without agentId is not remembered (fail-safe one-shot)', () => {
    const cache = new HitlDecisionCache();
    cache.remember('approve_always', 'effect', 'shell', {});
    expect(cache.get('effect', 'shell', { agentId: 'any' })).toBeNull();
  });

  it('approve_session without sessionId is not remembered (fail-safe one-shot)', () => {
    const cache = new HitlDecisionCache();
    cache.remember('approve_session', 'high_risk', 't', {});
    expect(cache.get('high_risk', 't', { sessionId: 's1' })).toBeNull();
  });

  it('clearSession drops only that session', () => {
    const cache = new HitlDecisionCache();
    cache.remember('approve_session', 'high_risk', 'a', { sessionId: 's1' });
    cache.remember('approve_session', 'high_risk', 'a', { sessionId: 's2' });
    cache.clearSession('s1');
    expect(cache.get('high_risk', 'a', { sessionId: 's1' })).toBeNull();
    expect(cache.get('high_risk', 'a', { sessionId: 's2' })).toBe('approve');
  });

  it('clearAgent drops only that agent always-grants', () => {
    const cache = new HitlDecisionCache();
    cache.remember('approve_always', 'effect', 'shell', { agentId: 'a1' });
    cache.remember('approve_always', 'effect', 'shell', { agentId: 'a2' });
    cache.clearAgent('a1');
    expect(cache.get('effect', 'shell', { agentId: 'a1' })).toBeNull();
    expect(cache.get('effect', 'shell', { agentId: 'a2' })).toBe('approve');
  });

  it('expires session approvals after TTL', () => {
    vi.useFakeTimers();
    try {
      const cache = new HitlDecisionCache(10);
      cache.remember('approve_session', 'high_risk', 'a', { sessionId: 's1' });
      expect(cache.get('high_risk', 'a', { sessionId: 's1' })).toBe('approve');
      vi.advanceTimersByTime(11);
      expect(cache.get('high_risk', 'a', { sessionId: 's1' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolveHitlDecision', () => {
  it('returns false when ask throws (fail-closed)', async () => {
    await expect(
      resolveHitlDecision({
        channel: 'high_risk',
        key: 't',
        sessionId: 's',
        ask: async () => {
          throw new Error('boom');
        },
      }),
    ).resolves.toBe(false);
  });

  it('returns false on deny', async () => {
    await expect(
      resolveHitlDecision({
        channel: 'high_risk',
        key: 't',
        ask: async () => 'deny',
      }),
    ).resolves.toBe(false);
  });

  it('does not re-enter hook after approve_session', async () => {
    const cache = new HitlDecisionCache();
    const ask = vi.fn(async () => 'approve_session' as const);
    await expect(
      resolveHitlDecision({ cache, channel: 'high_risk', key: 't', sessionId: 's', ask }),
    ).resolves.toBe(true);
    await expect(
      resolveHitlDecision({ cache, channel: 'high_risk', key: 't', sessionId: 's', ask }),
    ).resolves.toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('approve_always is agent-scoped in resolve', async () => {
    const cache = new HitlDecisionCache();
    const ask = vi.fn(async () => 'approve_always' as const);
    await resolveHitlDecision({
      cache,
      channel: 'effect',
      key: 'shell',
      sessionId: 's1',
      agentId: 'agent-a',
      ask,
    });
    await resolveHitlDecision({
      cache,
      channel: 'effect',
      key: 'shell',
      sessionId: 's2',
      agentId: 'agent-a',
      ask,
    });
    expect(ask).toHaveBeenCalledTimes(1);
    // 另一 agent 仍会问
    await resolveHitlDecision({
      cache,
      channel: 'effect',
      key: 'shell',
      sessionId: 's3',
      agentId: 'agent-b',
      ask,
    });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('re-enters hook after one-shot approve', async () => {
    const cache = new HitlDecisionCache();
    const ask = vi.fn(async () => 'approve' as const);
    await resolveHitlDecision({ cache, channel: 'high_risk', key: 't', sessionId: 's', ask });
    await resolveHitlDecision({ cache, channel: 'high_risk', key: 't', sessionId: 's', ask });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('concurrent same-key confirms share one ask (in-flight de-dup)', async () => {
    const cache = new HitlDecisionCache();
    let release!: (d: 'approve_session') => void;
    const gate = new Promise<'approve_session'>((r) => {
      release = r;
    });
    const ask = vi.fn(() => gate);
    const p1 = resolveHitlDecision({ cache, channel: 'effect', key: 'shell', sessionId: 's', ask });
    const p2 = resolveHitlDecision({ cache, channel: 'effect', key: 'shell', sessionId: 's', ask });
    release('approve_session');
    await expect(p1).resolves.toBe(true);
    await expect(p2).resolves.toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    // decision is now cached; a third call also skips ask
    await resolveHitlDecision({ cache, channel: 'effect', key: 'shell', sessionId: 's', ask });
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe('gateEffect + HitlDecisionCache', () => {
  it('approve_session 覆盖同一命令；不同命令各自确认（缓存 key 含目标，2026-10-26 翻案）', async () => {
    const cache = new HitlDecisionCache();
    const confirm: ConfirmEffect = vi.fn(async () => 'approve_session' as const);
    const opts = {
      effects: 'host-gate' as const,
      confirmEffect: confirm,
      shellEscape: 'confirm' as const,
      sessionId: 'sess-1',
      agentId: 'agent-a',
      hitlCache: cache,
    };
    await gateEffect({ kind: 'shell', command: 'ls' }, opts);
    // 同一目标：吃会话缓存，不再问
    await gateEffect({ kind: 'shell', command: 'ls' }, opts);
    // 不同目标：各自确认（旧「一类放行」已翻案）
    await gateEffect({ kind: 'shell', command: 'pwd' }, opts);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('approve_always does not leak across agents', async () => {
    const cache = new HitlDecisionCache();
    const confirm: ConfirmEffect = vi.fn(async () => 'approve_always' as const);
    await gateEffect(
      { kind: 'shell', command: 'ls' },
      {
        effects: 'host-gate',
        confirmEffect: confirm,
        shellEscape: 'confirm',
        agentId: 'agent-a',
        hitlCache: cache,
      },
    );
    await gateEffect(
      { kind: 'shell', command: 'ls' },
      {
        effects: 'host-gate',
        confirmEffect: confirm,
        shellEscape: 'confirm',
        agentId: 'agent-a',
        hitlCache: cache,
      },
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    await gateEffect(
      { kind: 'shell', command: 'ls' },
      {
        effects: 'host-gate',
        confirmEffect: confirm,
        shellEscape: 'confirm',
        agentId: 'agent-b',
        hitlCache: cache,
      },
    );
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('deny is not remembered', async () => {
    const cache = new HitlDecisionCache();
    const confirm: ConfirmEffect = vi.fn(async () => 'deny' as const);
    await expect(
      gateEffect(
        { kind: 'shell', command: 'ls' },
        {
          effects: 'host-gate',
          confirmEffect: confirm,
          shellEscape: 'confirm',
          sessionId: 'sess-1',
          hitlCache: cache,
        },
      ),
    ).rejects.toThrow(/effect_denied/);
    await expect(
      gateEffect(
        { kind: 'shell', command: 'ls' },
        {
          effects: 'host-gate',
          confirmEffect: confirm,
          shellEscape: 'confirm',
          sessionId: 'sess-1',
          hitlCache: cache,
        },
      ),
    ).rejects.toThrow(/effect_denied/);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
