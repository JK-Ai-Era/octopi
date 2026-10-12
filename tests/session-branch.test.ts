/**
 * Session 分叉 — copy-prefix
 *
 * 从 beforeIndex 切前缀建新会话：含 [0, beforeIndex)，不含该条。
 * 原会话 Discourse 不动；compact 作种子写到新 (sessionId, agentId)。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { InMemorySessionStore } from '@octopi-agent/engine/harness/session/in-memory-store.js';
import type { Message } from '@octopi-agent/core/types.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { GatewayConfig } from '@octopi-agent/core/types.js';

function userMsg(text: string, at = Date.now()): Message {
  return { role: 'user', content: text, timestamp: at };
}
function assistantMsg(text: string, at = Date.now()): Message {
  return { role: 'assistant', content: text, timestamp: at, agentId: 'a1' };
}

function baseMeta(id: string, t: number) {
  return {
    id,
    agentId: 'a1',
    channelId: 'web',
    peerId: 'p',
    status: 'idle' as const,
    createdAt: t,
    sessionStartedAt: t,
    lastInteractionAt: t,
    updatedAt: t,
  };
}

describe('session branch (copy-prefix)', () => {
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

  it('beforeIndex 切前缀；原会话不变；溯源与 compact 种子落新会话', async () => {
    const t = Date.now() - 60_000;
    const src: SessionData = {
      id: 'src-1',
      agentId: 'a1',
      primaryAgentId: 'a1',
      meta: baseMeta('src-1', t),
      messages: [
        userMsg('u0', t),
        assistantMsg('a0', t + 1),
        userMsg('u1-branch-here', t + 2),
        assistantMsg('a1', t + 3),
        userMsg('u2', t + 4),
      ],
      turns: [],
      metadata: {},
      tasks: [],
      contextCompact: {
        summary: '[Conversation Summary]\n\nprefix-seed',
        lastProactiveMessageCount: 2,
      },
    };
    await store.save('src-1', src);

    const meta = await gateway.branchSession('src-1', {
      beforeIndex: 2,
      agentId: 'a1',
    });
    expect(meta.id).toMatch(/branch/);

    const branched = await store.load(meta.id);
    expect(branched).toBeTruthy();
    expect(branched!.messages.map((m) => m.content)).toEqual(['u0', 'a0']);
    expect(branched!.metadata.parentSessionId).toBe('src-1');
    expect(branched!.metadata.branchFromIndex).toBe(2);
    expect(branched!.primaryAgentId).toBe('a1');
    expect(branched!.contextCompact?.summary).toContain('prefix-seed');

    const original = await store.load('src-1');
    expect(original!.messages).toHaveLength(5);
    expect(original!.messages[2].content).toBe('u1-branch-here');
  });

  it('beforeIndex 越界拒绝；beforeIndex=0 得到空前缀', async () => {
    const t = Date.now();
    await store.save('src-2', {
      id: 'src-2',
      agentId: 'a1',
      primaryAgentId: 'a1',
      meta: baseMeta('src-2', t),
      messages: [userMsg('only', t)],
      turns: [],
      metadata: {},
      tasks: [],
    });

    await expect(
      gateway.branchSession('src-2', { beforeIndex: 99, agentId: 'a1' }),
    ).rejects.toThrow(/beforeIndex/);

    const empty = await gateway.branchSession('src-2', { beforeIndex: 0, agentId: 'a1' });
    const loaded = await store.load(empty.id);
    expect(loaded!.messages).toHaveLength(0);
    expect(loaded!.metadata.parentSessionId).toBe('src-2');
  });

  it('getSessionMessages 附带绝对 index', async () => {
    const t = Date.now();
    await store.save('src-3', {
      id: 'src-3',
      agentId: 'a1',
      primaryAgentId: 'a1',
      meta: baseMeta('src-3', t),
      messages: [userMsg('m0', t), assistantMsg('m1', t + 1), userMsg('m2', t + 2)],
      turns: [],
      metadata: {},
      tasks: [],
    });

    const page = await gateway.getSessionMessages('src-3', { limit: 2 });
    expect(page.messages.map((m) => m.index)).toEqual([0, 1]);
    const page2 = await gateway.getSessionMessages('src-3', {
      limit: 2,
      cursor: page.nextCursor,
    });
    expect(page2.messages.map((m) => m.index)).toEqual([2]);
  });
});
