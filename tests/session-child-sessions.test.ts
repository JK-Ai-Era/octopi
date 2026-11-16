/**
 * Gateway.listChildSessions — 右栏"子会话"数据源（委派 spawnBy 归属，D7）
 *
 * 锚：
 * ① 只回直接子会话（spawnBy.parentSessionId 命中），孙代不进父层列表（UI 逐层下钻）；
 * ② 按 createdAt 倒序；带 running 投影；不按 agentId 收口（子会话归属子 agent）；
 * ③ 父会话不存在 fail-loud（与 getSessionTasks 同口径 not found）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { ServerResponse } from 'node:http';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { WebApiRouter } from '@octopi-agent/gateway/web/api/router.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { GatewayConfig } from '@octopi-agent/gateway/types/gateway-config.js';

function makeSession(
  agentId: string,
  sessionId: string,
  createdAt: number,
  spawnBy?: SessionData['spawnBy'],
): SessionData {
  return {
    id: sessionId,
    agentId,
    meta: {
      id: sessionId,
      agentId,
      channelId: 'web',
      peerId: 'ui',
      status: 'idle',
      createdAt,
      sessionStartedAt: createdAt,
      lastInteractionAt: createdAt,
      updatedAt: createdAt,
    },
    messages: [],
    steps: [],
    metadata: {},
    ...(spawnBy ? { spawnBy } : {}),
  };
}

describe('Gateway.listChildSessions', () => {
  let store: InMemorySessionStore;
  let gateway: Gateway;

  beforeEach(async () => {
    store = new InMemorySessionStore();
    const config = {
      agents: [
        { id: 'a1', model: { provider: 'mock', model: 'mock' } },
        { id: 'a2', model: { provider: 'mock', model: 'mock' } },
      ],
    } as unknown as GatewayConfig;
    gateway = new Gateway(config, store);

    await store.save('parent-1', makeSession('a1', 'parent-1', 1000));
    // 子会话归属子 agent a2（跨 agent：列表不得按 agentId 收口）
    await store.save(
      'child-old',
      makeSession('a2', 'child-old', 2000, {
        delegationId: 'del-1',
        parentAgentId: 'a1',
        parentSessionId: 'parent-1',
        parentRunId: 'run-1',
        depth: 1,
      }),
    );
    await store.save(
      'child-new',
      makeSession('a2', 'child-new', 3000, {
        delegationId: 'del-2',
        parentAgentId: 'a1',
        parentSessionId: 'parent-1',
        parentRunId: 'run-2',
        depth: 1,
      }),
    );
    // 孙代：parent 是 child-new，不得进 parent-1 的列表
    await store.save(
      'grandchild',
      makeSession('a2', 'grandchild', 4000, {
        delegationId: 'del-3',
        parentAgentId: 'a2',
        parentSessionId: 'child-new',
        parentRunId: 'run-3',
        depth: 2,
      }),
    );
    // 用户直接创建的会话：无 spawnBy，不得出现在任何子会话列表
    await store.save('plain', makeSession('a1', 'plain', 5000));
  });

  it('只回直接子会话，按 createdAt 倒序，带 running 投影', async () => {
    const children = await gateway.listChildSessions('parent-1');
    expect(children.map((c) => c.id)).toEqual(['child-new', 'child-old']);
    expect(children.every((c) => c.running === false)).toBe(true);
    expect(children[0].spawnBy?.delegationId).toBe('del-2');
  });

  it('running 投影跟随 runtime 活跃 Run（真 true/false 路径）', async () => {
    const runtime = gateway['runtime'] as unknown as { hasActiveRunForSession: (id: string) => boolean };
    runtime.hasActiveRunForSession = (id) => id === 'child-new';
    const children = await gateway.listChildSessions('parent-1');
    expect(children.find((c) => c.id === 'child-new')?.running).toBe(true);
    expect(children.find((c) => c.id === 'child-old')?.running).toBe(false);
  });

  it('嵌套委派逐层下钻：child-new 的子会话是 grandchild', async () => {
    const children = await gateway.listChildSessions('child-new');
    expect(children.map((c) => c.id)).toEqual(['grandchild']);
    expect(children[0].spawnBy?.depth).toBe(2);
  });

  it('叶子会话回空列表；用户会话不误收', async () => {
    expect(await gateway.listChildSessions('grandchild')).toEqual([]);
    expect(await gateway.listChildSessions('plain')).toEqual([]);
  });

  it('父会话不存在时抛 not found', async () => {
    await expect(gateway.listChildSessions('missing')).rejects.toThrow(/not found/i);
  });
});

describe('WebApiRouter /sessions/:id/children 路由映射', () => {
  interface CallResult {
    handled: boolean;
    status: number;
    body: { ok: boolean; error?: string; data?: unknown } | null;
    headers: Record<string, string>;
  }

  async function call(router: WebApiRouter, url: string): Promise<CallResult> {
    const req = { url, method: 'GET', headers: { host: 'localhost' } } as unknown as IncomingMessage;
    let status = 0;
    let body: CallResult['body'] = null;
    const headers: Record<string, string> = {};
    const res = {
      writeHead(code: number) {
        status = code;
        return this;
      },
      setHeader(name: string, value: string) {
        headers[name] = value;
        return this;
      },
      end(payload?: string) {
        body = payload ? JSON.parse(payload) : null;
        return this;
      },
    } as unknown as ServerResponse;
    const handled = await router.handle(req, res);
    return { handled, status, body, headers };
  }

  it('200 透传子会话列表 / 404 父缺失（not found 映射）', async () => {
    const stub = {
      listChildSessions: async (id: string) => {
        if (id === 'missing') throw new Error('Session "missing" not found');
        return [{ id: 'child-1', agentId: 'a2', createdAt: 2, running: false }];
      },
    };
    const router = new WebApiRouter({ gateway: stub as unknown as Gateway });

    const ok = await call(router, '/api/v1/sessions/parent-1/children');
    expect(ok.handled).toBe(true);
    expect(ok.status).toBe(200);
    expect(ok.body?.ok).toBe(true);
    expect(ok.body?.data).toEqual([{ id: 'child-1', agentId: 'a2', createdAt: 2, running: false }]);

    const missing = await call(router, '/api/v1/sessions/missing/children');
    expect(missing.status).toBe(404);
    expect(missing.body?.ok).toBe(false);
  });
});
