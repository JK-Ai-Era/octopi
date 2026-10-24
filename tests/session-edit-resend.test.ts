/**
 * 编辑重发 — 同会话原地截断 + 重发（不建分支）
 *
 * 中止轮：truncateMessagesFrom(userMessageIndex) 丢掉该用户输入与残片；
 * 再 send 发送编辑后的文本。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { InMemorySessionStore } from '@octopi-agent/engine/harness/session/in-memory-store.js';
import type { Message } from '@octopi-agent/core/types.js';
import type { GatewayConfig } from '@octopi-agent/gateway/types/gateway-config.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';

function userMsg(text: string, at = Date.now()): Message {
  return { role: 'user', content: text, timestamp: at };
}
function assistantMsg(text: string, at = Date.now()): Message {
  return { role: 'assistant', content: text, timestamp: at, agentId: 'a1' };
}

describe('edit-resend (truncate aborted turn)', () => {
  let store: InMemorySessionStore;
  let gateway: Gateway;

  beforeEach(() => {
    store = new InMemorySessionStore();
    gateway = new Gateway(
      {
        agents: [{ id: 'a1', model: { provider: 'mock', model: 'm' } }],
      } as unknown as GatewayConfig,
      store,
    );
  });

  it('truncate 从用户下标起丢掉中止残片；清除 abortedTurn 标记', async () => {
    const t = Date.now();
    await store.save('s-edit', {
      id: 's-edit',
      agentId: 'a1',
      primaryAgentId: 'a1',
      meta: {
        id: 's-edit',
        agentId: 'a1',
        channelId: 'web',
        peerId: 'p',
        status: 'idle',
        createdAt: t,
        sessionStartedAt: t,
        lastInteractionAt: t,
        updatedAt: t,
      },
      messages: [
        userMsg('earlier', t),
        assistantMsg('ok', t + 1),
        userMsg('wrong message', t + 2),
        assistantMsg('partial debris', t + 3),
        { role: 'tool', content: 'tool debris', timestamp: t + 4, toolResults: [] } as Message,
      ],
      turns: [],
      metadata: {
        abortedTurn: { userMessageIndex: 2, at: t + 5 },
      },
      tasks: [],
      contextDetachIndex: 2,
    });

    const result = await gateway.truncateMessagesFrom('s-edit', 2);
    expect(result.messageCount).toBe(2);

    const session = await store.load('s-edit');
    expect(session!.messages.map((m) => m.content)).toEqual(['earlier', 'ok']);
    // save 浅合并删不掉键：必须 updateMetadata；重载后不得再出现
    expect(session!.metadata.abortedTurn).toBeUndefined();
    expect(session!.contextDetachIndex).toBe(2);

    const view = await gateway.getSessionView('s-edit');
    expect(view?.abortedTurn).toBeUndefined();
    expect(view?.messageCount).toBe(2);
  });

  it('truncate 收缩 contextDetachIndex，避免 LLM 窗口被裁空', async () => {
    const t = Date.now();
    await store.save('s-lease', {
      id: 's-lease',
      agentId: 'a1',
      primaryAgentId: 'a1',
      meta: {
        id: 's-lease',
        agentId: 'a1',
        channelId: 'web',
        peerId: 'p',
        status: 'idle',
        createdAt: t,
        sessionStartedAt: t,
        lastInteractionAt: t,
        updatedAt: t,
      },
      messages: [userMsg('u0', t), assistantMsg('a0', t + 1), userMsg('u1', t + 2)],
      turns: [],
      metadata: { abortedTurn: { userMessageIndex: 0, at: t } },
      tasks: [],
      // 租约点在消息之后（大于 truncate 起点），用于验证 detach 随截断收缩
      contextDetachIndex: 2,
    });

    // 编辑重发只允许从 abortedTurn 起点截断；detach 必须跟着收到 fromIndex
    await gateway.truncateMessagesFrom('s-lease', 0);
    const session = await store.load('s-lease');
    expect(session!.messages).toHaveLength(0);
    expect(session!.contextDetachIndex).toBe(0);
    expect(session!.metadata.abortedTurn).toBeUndefined();
  });

  it('getSessionView 暴露 abortedTurn；越界 truncate 拒绝', async () => {
    const t = Date.now();
    await store.save('s-view', {
      id: 's-view',
      agentId: 'a1',
      primaryAgentId: 'a1',
      meta: {
        id: 's-view',
        agentId: 'a1',
        channelId: 'web',
        peerId: 'p',
        status: 'idle',
        createdAt: t,
        sessionStartedAt: t,
        lastInteractionAt: t,
        updatedAt: t,
      },
      messages: [userMsg('u', t), assistantMsg('partial', t + 1)],
      turns: [],
      metadata: { abortedTurn: { userMessageIndex: 0, at: t } },
      tasks: [],
    });

    const view = await gateway.getSessionView('s-view');
    expect(view?.abortedTurn?.userMessageIndex).toBe(0);

    await expect(gateway.truncateMessagesFrom('s-view', 99)).rejects.toThrow(/fromIndex/);
    await expect(gateway.truncateMessagesFrom('missing', 0)).rejects.toThrow(/not found/);
  });

  it('过期 abortedTurn（后续已有新用户消息）不在 view 暴露', async () => {
    const t = Date.now();
    await store.save('s-stale', {
      id: 's-stale',
      agentId: 'a1',
      primaryAgentId: 'a1',
      meta: {
        id: 's-stale',
        agentId: 'a1',
        channelId: 'web',
        peerId: 'p',
        status: 'idle',
        createdAt: t,
        sessionStartedAt: t,
        lastInteractionAt: t,
        updatedAt: t,
      },
      messages: [
        userMsg('first aborted', t),
        assistantMsg('partial', t + 1),
        userMsg('later completed', t + 2),
        assistantMsg('done', t + 3),
      ],
      turns: [],
      metadata: { abortedTurn: { userMessageIndex: 0, at: t } },
      tasks: [],
    });

    const view = await gateway.getSessionView('s-stale');
    expect(view?.abortedTurn).toBeUndefined();
  });

  it('中止轮后的 turnEnd/runStopped 引擎载体不算新用户消息，abortedTurn 仍可编辑重发', async () => {
    const t = Date.now();
    await store.save('s-carrier', {
      id: 's-carrier',
      agentId: 'a1',
      primaryAgentId: 'a1',
      meta: {
        id: 's-carrier',
        agentId: 'a1',
        channelId: 'web',
        peerId: 'p',
        status: 'idle',
        createdAt: t,
        sessionStartedAt: t,
        lastInteractionAt: t,
        updatedAt: t,
      },
      messages: [
        userMsg('wrong message', t),
        assistantMsg('partial debris', t + 1),
        // 与 Runner 收尾顺序一致：先 runStopped（引擎自停收口）后 appendTurnEnd（无条件闭标），
        // 均为 role=user 的引擎载体
        {
          role: 'user',
          content: '引擎判定停止：本轮由引擎主动终止',
          timestamp: t + 2,
          metadata: { source: 'runStopped', stopReason: 'behavior_stopped' },
        } as Message,
        {
          role: 'user',
          content: '<turn_end id="t1"/>',
          timestamp: t + 3,
          metadata: { source: 'turnEnd', turnId: 't1' },
        } as Message,
      ],
      turns: [],
      metadata: { abortedTurn: { userMessageIndex: 0, at: t + 4 } },
      tasks: [],
    });

    const view = await gateway.getSessionView('s-carrier');
    expect(view?.abortedTurn?.userMessageIndex).toBe(0);

    // view 暴露后 truncate 必须被接受（编辑重发端到端不被拒）
    const result = await gateway.truncateMessagesFrom('s-carrier', 0);
    expect(result.messageCount).toBe(0);
    const session = await store.load('s-carrier');
    expect(session!.metadata.abortedTurn).toBeUndefined();
  });

  it('载体跳过不得过度：引擎载体之后出现真实用户消息仍判标记过期', async () => {
    const t = Date.now();
    await store.save('s-over-skip', {
      id: 's-over-skip',
      agentId: 'a1',
      primaryAgentId: 'a1',
      meta: {
        id: 's-over-skip',
        agentId: 'a1',
        channelId: 'web',
        peerId: 'p',
        status: 'idle',
        createdAt: t,
        sessionStartedAt: t,
        lastInteractionAt: t,
        updatedAt: t,
      },
      messages: [
        userMsg('aborted input', t),
        assistantMsg('partial', t + 1),
        {
          role: 'user',
          content: '<turn_end id="t1"/>',
          timestamp: t + 2,
          metadata: { source: 'turnEnd', turnId: 't1' },
        } as Message,
        userMsg('real follow-up', t + 3),
        assistantMsg('done', t + 4),
      ],
      turns: [],
      metadata: { abortedTurn: { userMessageIndex: 0, at: t + 5 } },
      tasks: [],
    });

    const view = await gateway.getSessionView('s-over-skip');
    expect(view?.abortedTurn).toBeUndefined();
  });

  it('legacy 标记指向引擎载体时不暴露、truncate 拒绝（锚点必须是真实用户消息）', async () => {
    const t = Date.now();
    await store.save('s-bad-anchor', {
      id: 's-bad-anchor',
      agentId: 'a1',
      primaryAgentId: 'a1',
      meta: {
        id: 's-bad-anchor',
        agentId: 'a1',
        channelId: 'web',
        peerId: 'p',
        status: 'idle',
        createdAt: t,
        sessionStartedAt: t,
        lastInteractionAt: t,
        updatedAt: t,
      },
      messages: [
        userMsg('real user turn', t),
        assistantMsg('partial', t + 1),
        {
          role: 'user',
          content: '<turn_end id="t1"/>',
          timestamp: t + 2,
          metadata: { source: 'turnEnd', turnId: 't1' },
        } as Message,
      ],
      turns: [],
      // 损坏/legacy 元数据：锚点落在引擎载体上（下标 2）
      metadata: { abortedTurn: { userMessageIndex: 2, at: t + 3 } },
      tasks: [],
    });

    const view = await gateway.getSessionView('s-bad-anchor');
    expect(view?.abortedTurn).toBeUndefined();
    await expect(gateway.truncateMessagesFrom('s-bad-anchor', 2)).rejects.toThrow(
      /anchor is not a real user message/,
    );
  });
});
