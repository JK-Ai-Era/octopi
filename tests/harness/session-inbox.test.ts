/**
 * SessionInbox — 活跃 Run 消息接续队列契约
 *
 * 不变量：
 * - offer 只被持锁的活跃 Run 接收（steered）；否则走原 Trigger 唤醒（dispatched）
 * - 同 entryId 只进一次父上下文（owned / delivered 去重）
 * - close 未消费 = 未送达：按原 Trigger 重投（带 onEvent），已 ack 不重投
 * - 显式换模型 / 带附件输入不接续（完整新 Run 装配）
 */

import { describe, it, expect, vi } from 'vitest';
import { SessionInbox } from '@octopi-agent/engine/harness/activation/inbox.js';
import type { SessionInboxEntry } from '@octopi-agent/engine/harness/activation/inbox.js';
import type { Message } from '@octopi-agent/core/types.js';

function msg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function triggerOf(id: string) {
  return {
    id,
    type: 'message' as const,
    agentId: 'a1',
    sessionId: 's1',
    timestamp: Date.now(),
    payload: { kind: 'user_message' as const, content: id },
    metadata: {},
  };
}

describe('SessionInbox', () => {
  it('无活跃接收端时返回 dispatched（原 Trigger 负责唤醒）', () => {
    const inbox = new SessionInbox(() => {});
    expect(
      inbox.offer({ agentId: 'a1', sessionId: 's1', message: msg('hi'), entryId: 'e1' }),
    ).toBe('dispatched');
  });

  it('活跃 Run 接收：steered + onAdmitted，drain 人话优先且保持到达序', () => {
    const inbox = new SessionInbox(() => {});
    const run = inbox.open('s1', 'a1', 'r1', []);
    const admitted = vi.fn();
    expect(
      inbox.offer({ agentId: 'a1', sessionId: 's1', message: msg('notice-1'), entryId: 'n1' }),
    ).toBe('steered');
    expect(
      inbox.offer({
        agentId: 'a1',
        sessionId: 's1',
        message: msg('human-1'),
        entryId: 'h1',
        human: true,
        onAdmitted: admitted,
      }),
    ).toBe('steered');
    expect(
      inbox.offer({ agentId: 'a1', sessionId: 's1', message: msg('notice-2'), entryId: 'n2' }),
    ).toBe('steered');
    expect(admitted).toHaveBeenCalledWith('steered');

    const drained = run.drain();
    expect(drained.map((e) => e.id)).toEqual(['h1', 'n1', 'n2']);
  });

  it('同 entryId 去重：owned（在途）与 delivered（已入上下文）都拒绝二次进入', () => {
    const inbox = new SessionInbox(() => {});
    const run = inbox.open('s1', 'a1', 'r1', []);
    expect(
      inbox.offer({ agentId: 'a1', sessionId: 's1', message: msg('x'), entryId: 'e1' }),
    ).toBe('steered');
    // owned：同一 id 再来不得重复排队
    expect(
      inbox.offer({ agentId: 'a1', sessionId: 's1', message: msg('x'), entryId: 'e1' }),
    ).toBe('duplicate');

    const [entry] = run.drain();
    inbox.ack(entry!);
    // delivered：已进父上下文，重发/重投都不再执行
    expect(
      inbox.offer({ agentId: 'a1', sessionId: 's1', message: msg('x'), entryId: 'e1' }),
    ).toBe('duplicate');
  });

  it('显式换模型 / 带附件输入不接续（返回 dispatched）', () => {
    const inbox = new SessionInbox(() => {});
    inbox.open('s1', 'a1', 'r1', []);
    expect(
      inbox.offer({
        agentId: 'a1',
        sessionId: 's1',
        message: msg('m'),
        entryId: 'e1',
        modelOverride: 'gpt-x',
      }),
    ).toBe('dispatched');
    expect(
      inbox.offer({
        agentId: 'a1',
        sessionId: 's1',
        message: { ...msg('a'), metadata: { attachmentIds: ['att-1'] } },
        entryId: 'e2',
      }),
    ).toBe('dispatched');
  });

  it('会话级同模型不是换模型：与活跃 Run 同 (model, provider) 仍可接续（评审 F5）', () => {
    const inbox = new SessionInbox(() => {});
    inbox.open('s1', 'a1', 'r1', [], { model: 'gpt-x', provider: 'openai' });
    // 同模型（会话选择逐条下发）→ 接续，插话不静默退化为排队
    expect(
      inbox.offer({
        agentId: 'a1',
        sessionId: 's1',
        message: msg('interject'),
        entryId: 'e1',
        human: true,
        modelOverride: 'gpt-x',
        modelProvider: 'openai',
      }),
    ).toBe('steered');
    // 真换模型 → 完整新 Run（保模型快照）
    expect(
      inbox.offer({
        agentId: 'a1',
        sessionId: 's1',
        message: msg('switch'),
        entryId: 'e2',
        modelOverride: 'gpt-y',
        modelProvider: 'openai',
      }),
    ).toBe('dispatched');
  });

  it('close 未消费：按原 Trigger 重投（带 onEvent），且只投一次', async () => {
    const redispatch = vi.fn();
    const inbox = new SessionInbox(redispatch);
    const run = inbox.open('s1', 'a1', 'r1', []);
    const onEvent = vi.fn();
    const trigger = triggerOf('t1');
    expect(
      inbox.offer({
        agentId: 'a1',
        sessionId: 's1',
        message: msg('result'),
        entryId: 'del-1',
        trigger,
        onEvent,
      }),
    ).toBe('steered');

    run.close();
    await vi.waitFor(() => expect(redispatch).toHaveBeenCalledTimes(1));
    const [entry] = redispatch.mock.calls[0] as unknown as [SessionInboxEntry];
    expect(entry.id).toBe('del-1');
    expect(entry.trigger).toBe(trigger);
    expect(entry.onEvent).toBe(onEvent);
    // close 幂等：重复 close 不得再投
    run.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(redispatch).toHaveBeenCalledTimes(1);
  });

  it('close 前已 ack 的消息不重投', async () => {
    const redispatch = vi.fn();
    const inbox = new SessionInbox(redispatch);
    const run = inbox.open('s1', 'a1', 'r1', []);
    inbox.offer({ agentId: 'a1', sessionId: 's1', message: msg('x'), entryId: 'e1' });
    const [entry] = run.drain();
    inbox.ack(entry!);
    run.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(redispatch).not.toHaveBeenCalled();
  });

  it('take 精确领取初始输入：后续 drain 不得重复消费', () => {
    const inbox = new SessionInbox(() => {});
    const initial: SessionInboxEntry = {
      id: 'init',
      agentId: 'a1',
      sessionId: 's1',
      message: msg('hi'),
      human: true,
      receivedAt: Date.now(),
    };
    const run = inbox.open('s1', 'a1', 'r1', [initial]);
    expect(run.take('init')?.id).toBe('init');
    expect(run.take('init')).toBeUndefined();
    expect(run.drain()).toEqual([]);
  });

  it('同 (agent, session) 不允许两个活跃接收端', () => {
    const inbox = new SessionInbox(() => {});
    inbox.open('s1', 'a1', 'r1', []);
    expect(() => inbox.open('s1', 'a1', 'r2', [])).toThrow(/already open/);
    // 不同 session 互不影响
    expect(() => inbox.open('s2', 'a1', 'r3', [])).not.toThrow();
  });
});
