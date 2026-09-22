/**
 * Gateway.getSessionTasks — UI 只读任务 API
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Gateway } from '../src/integration/gateway/gateway.js';
import { InMemorySessionStore } from '../src/integration/storage/memory.js';
import type { SessionData } from '../src/harness/session-types.js';
import type { GatewayConfig } from '../src/core/types.js';

function makeSession(agentId: string, sessionId: string, tasks: SessionData['tasks']): SessionData {
  return {
    id: sessionId,
    agentId,
    meta: {
      id: sessionId,
      agentId,
      channelId: 'web',
      peerId: 'ui',
      status: 'idle',
      createdAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [],
    turns: [],
    metadata: {},
    tasks,
  };
}

describe('Gateway.getSessionTasks', () => {
  let store: InMemorySessionStore;
  let gateway: Gateway;

  beforeEach(async () => {
    store = new InMemorySessionStore();
    const config = {
      agents: [
        {
          id: 'a1',
          model: { provider: 'mock', model: 'mock' },
        },
      ],
    } as unknown as GatewayConfig;
    gateway = new Gateway(config, store);

    const session = makeSession('a1', 's1', [
      {
        id: 'g1',
        description: '分析代码',
        status: 'open',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 's1',
        parentId: 'g1',
        description: '扫描',
        status: 'done',
        order: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    await store.save('s1', session);
  });

  it('返回会话任务列表', async () => {
    const tasks = await gateway.getSessionTasks('s1');
    expect(tasks).toHaveLength(2);
    expect(tasks?.[0].id).toBe('g1');
    expect(tasks?.[1].parentId).toBe('g1');
  });

  it('session 不存在时抛错', async () => {
    await expect(gateway.getSessionTasks('missing')).rejects.toThrow(/not found/i);
  });

  it('getSessionView 含 taskCount', async () => {
    const view = await gateway.getSessionView('s1');
    expect(view?.taskCount).toBe(2);
  });
});
