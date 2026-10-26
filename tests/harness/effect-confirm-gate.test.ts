/**
 * 效应确认语义对齐测试（归因回传 / 错误分家 / 缓存 key 含目标）。
 *
 * 背景：host-gate 效应确认曾丢弃 ConfirmOutcome 归因、把超时与人工拒绝混为
 * `effect_denied`、缓存 key 只按 kind（一次点头放行一类）。
 *
 * 规格：docs/KNOWN-ISSUES HITL 单模型段 + core ConfirmOutcome 契约。
 */
import { describe, it, expect } from 'vitest';

import { gateEffect } from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';
import { HitlDecisionCache } from '@octopi-agent/engine/harness/governance/human-in-the-loop/decision-cache.js';
import type { ConfirmOutcome, HitlDecision } from '@octopi-agent/core/types/tools.js';

type Decide = (intent: unknown) => Promise<HitlDecision | ConfirmOutcome>;

const fileIntent = (path: string) => ({
  kind: 'file.write' as const,
  path,
  mode: 'overwrite' as const,
  transactional: false,
});

const run = (intent: ReturnType<typeof fileIntent>, decide: Decide, hitlCache: HitlDecisionCache) =>
  gateEffect(intent, {
    effects: 'host-gate',
    confirmEffect: decide as never,
    sessionId: 's1',
    agentId: 'a1',
    hitlCache,
  });

describe('效应确认归因回传（ops P5）', () => {
  it('人工批准 → GateEffectResult 带 confirmedBy/confirmChannel', async () => {
    const result = await run(fileIntent('/tmp/a.txt'), async () => ({
      decision: 'approve',
      approver: 'owner',
      channel: 'gateway',
    }), new HitlDecisionCache());

    expect(result).toMatchObject({
      confirmed: true,
      confirmSource: 'host-gate',
      confirmedBy: 'owner',
      confirmChannel: 'gateway',
    });
  });

  it('缓存命中 → 归因如实缺省（不冒充人工）', async () => {
    const cache = new HitlDecisionCache();
    const decide: Decide = async () => ({
      decision: 'approve_session',
      approver: 'owner',
      channel: 'gateway',
    });
    await run(fileIntent('/tmp/a.txt'), decide, cache);
    const cached = await run(fileIntent('/tmp/a.txt'), decide, cache);

    expect(cached.confirmed).toBe(true);
    expect(cached.confirmedBy).toBeUndefined();
    expect(cached.confirmChannel).toBeUndefined();
  });
});

describe('效应确认错误分家（超时 ≠ 人工拒绝 ≠ 通道故障）', () => {
  it('宿主报 reason:timeout → effect_confirm_timeout（勿盲重试语义）', async () => {
    const err = await run(fileIntent('/tmp/a.txt'), async () => ({
      decision: 'deny',
      reason: 'timeout',
    }), new HitlDecisionCache()).then(
      () => null,
      (e: Error) => e,
    );

    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/effect_confirm_timeout:.*do NOT retry/s);
    expect(err!.message).not.toMatch(/a human rejected/);
  });

  it('人工拒绝 → effect_denied 标注人工', async () => {
    const err = await run(fileIntent('/tmp/a.txt'), async () => 'deny', new HitlDecisionCache()).then(
      () => null,
      (e: Error) => e,
    );

    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/effect_denied:.*a human rejected/s);
    expect(err!.message).not.toMatch(/effect_confirm_timeout/);
  });

  it('宿主报其他 reason（如 no_session_scope）→ 通道故障标注，不冒充人工', async () => {
    const err = await run(fileIntent('/tmp/a.txt'), async () => ({
      decision: 'deny',
      reason: 'no_session_scope',
    }), new HitlDecisionCache()).then(
      () => null,
      (e: Error) => e,
    );

    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/effect_denied:.*no_session_scope.*no human decision/s);
    expect(err!.message).not.toMatch(/a human rejected/);
  });
});

describe('效应确认缓存 key 含目标（旧粗粒度已翻案）', () => {
  it('approve_session 放行 /tmp/a.txt 不覆盖 /tmp/b.txt', async () => {
    const cache = new HitlDecisionCache();
    const asked: string[] = [];
    const decide: Decide = async (intent) => {
      asked.push((intent as { path: string }).path);
      return 'approve_session';
    };

    await run(fileIntent('/tmp/a.txt'), decide, cache);
    const second = await run(fileIntent('/tmp/b.txt'), decide, cache).then(
      () => null,
      (e: Error) => e,
    );

    // 第二个目标仍要走确认（decide 被再问一次；本例 decide 直接放行，但问过 = 未被缓存吞掉）
    expect(second).toBeNull();
    expect(asked).toEqual(['/tmp/a.txt', '/tmp/b.txt']);

    // 同一目标重跑才吃缓存
    await run(fileIntent('/tmp/a.txt'), decide, cache);
    expect(asked).toEqual(['/tmp/a.txt', '/tmp/b.txt']);
  });
});
