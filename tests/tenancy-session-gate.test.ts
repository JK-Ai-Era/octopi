/**
 * T4b 单会话端点/事件/调试面租户闸（arch/multi-tenancy.md §9.1-3）。
 *
 * 测试纪律（T4b 评审方法论教训）：**真实 Gateway + 真实 store/registry**——
 * stub gateway 会把「闸建在恒返 undefined 的 getSession stub 上」这类断裂
 * 抹绿（评审 MAJ-1）。本文件全部经真链路断言。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { WebApiRouter } from '@octopi-agent/gateway/web/api/router.js';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import type { SessionMeta, TenantId } from '@octopi-agent/core/types.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import { createRegistryAgentBridge } from '../src/registry-bridge.js';

interface CallResult {
  status: number;
  body: { ok: boolean; error?: string; data?: Record<string, unknown> } | null;
}

async function call(
  router: WebApiRouter,
  opts: { method: string; url: string; body?: unknown; token?: string },
): Promise<CallResult> {
  const payload = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const headers: Record<string, string> = { host: 'localhost' };
  if (opts.token) headers['x-registry-token'] = opts.token;
  if (payload) headers['content-type'] = 'application/json';

  const req = Readable.from(payload ? [Buffer.from(payload)] : []) as IncomingMessage;
  Object.assign(req, { method: opts.method, url: opts.url, headers });

  const chunks: Buffer[] = [];
  let status = 0;
  const res = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  }) as unknown as ServerResponse;
  Object.assign(res, {
    writeHead(code: number) {
      status = code;
      return res;
    },
    setHeader() {},
    end(chunkOrCb?: unknown, encOrCb?: unknown, maybeCb?: unknown) {
      if (typeof chunkOrCb === 'string' || Buffer.isBuffer(chunkOrCb)) {
        chunks.push(Buffer.from(chunkOrCb as string));
      }
      const done =
        typeof chunkOrCb === 'function'
          ? chunkOrCb
          : typeof encOrCb === 'function'
            ? encOrCb
            : typeof maybeCb === 'function'
              ? maybeCb
              : undefined;
      (done as (() => void) | undefined)?.();
    },
  });

  await router.handle(req, res);
  const raw = Buffer.concat(chunks).toString('utf-8');
  return { status, body: raw ? (JSON.parse(raw) as CallResult['body']) : null };
}

function makeAgent(id: string) {
  return {
    id,
    home: join(tmpdir(), `gate-${id}-home`),
    workspace: join(tmpdir(), `gate-${id}-ws`),
    persona: { name: id, description: '', systemPrompt: 'S' },
    model: { provider: 'mock', model: 'm' },
    tools: { allow: [] },
  };
}

describe('T4b 单会话端点租户闸（真实 Gateway 链路）', () => {
  let root: string;
  let gateway: Gateway;
  let router: WebApiRouter;
  let rootToken: string; // 首注册 = 平台 admin
  let aliceToken: string; // 租户 A
  let bobToken: string; // 租户 B
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'session-gate-'));
    gateway = new Gateway(
      {
        agents: [makeAgent('host-agent')],
        knowledge: { service: { manageLocal: false } },
      },
      new InMemorySessionStore(),
    );
    gateway.setRegistryAgentBridge(
      createRegistryAgentBridge({
        getRawConfig: () => ({
          models: {
            providers: {
              mock: {
                baseUrl: 'http://127.0.0.1:1/v1',
                apiKey: 'test-key',
                api: 'openai-completions',
                models: [{ id: 'm', name: 'm', contextWindow: 32000, maxTokens: 4096 }],
              },
            },
          },
        }),
        homeDir: join(root, 'home'),
      }),
    );
    await gateway.start();
    router = new WebApiRouter({ gateway: gateway as unknown as Gateway });

    const regRoot = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/register',
      body: { name: 'root' },
    });
    rootToken = (regRoot.body?.data as { token: string }).token;
    const regA = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/register',
      body: { name: 'alice' },
    });
    aliceToken = (regA.body?.data as { token: string }).token;
    const regB = await call(router, {
      method: 'POST',
      url: '/api/v1/registry/register',
      body: { name: 'bob' },
    });
    bobToken = (regB.body?.data as { token: string }).token;

    const registry = gateway.getRegistry()!;
    tenantA = registry.resolveToken(aliceToken)!.tenantId;
    tenantB = registry.resolveToken(bobToken)!.tenantId;
  }, 30_000);

  afterAll(async () => {
    await gateway.stop();
    rmSync(root, { recursive: true, force: true });
  });

  async function makeSession(sessionId: string, tenantId: string): Promise<SessionMeta> {
    return gateway.createSession({
      agentId: 'host-agent',
      sessionId,
      tenantId: tenantId as never,
    });
  }

  it('同域直取 200 / 越域 404 不泄漏存在性 / admin 豁免 / 无头=宿主面', async () => {
    await makeSession('sess-a', tenantA);
    await makeSession('sess-b', tenantB);

    const own = await call(router, { method: 'GET', url: '/api/v1/sessions/sess-a', token: aliceToken });
    expect(own.status).toBe(200);

    const cross = await call(router, { method: 'GET', url: '/api/v1/sessions/sess-b', token: aliceToken });
    expect(cross.status).toBe(404);
    expect(cross.body?.error).toBe('Session not found');

    const admin = await call(router, { method: 'GET', url: '/api/v1/sessions/sess-b', token: rootToken });
    expect(admin.status).toBe(200);

    const hostPlane = await call(router, { method: 'GET', url: '/api/v1/sessions/sess-b' });
    expect(hostPlane.status).toBe(200);

    const bad = await call(router, { method: 'GET', url: '/api/v1/sessions/sess-a', token: 'nope' });
    expect(bad.status).toBe(401);
  });

  it('PATCH/DELETE 越域 404（同闸覆盖写操作）', async () => {
    await makeSession('sess-b', tenantB);
    const patch = await call(router, {
      method: 'PATCH',
      url: '/api/v1/sessions/sess-b',
      token: aliceToken,
      body: { pinned: true },
    });
    expect(patch.status).toBe(404);
    const del = await call(router, { method: 'DELETE', url: '/api/v1/sessions/sess-b', token: aliceToken });
    expect(del.status).toBe(404);
  });

  it('/sessions/:id/events 在闸内（MAJ-3 锚）：越域 404、同域 200', async () => {
    await makeSession('sess-a', tenantA);
    await makeSession('sess-b', tenantB);

    const cross = await call(router, { method: 'GET', url: '/api/v1/sessions/sess-b/events', token: aliceToken });
    expect(cross.status).toBe(404);

    const own = await call(router, { method: 'GET', url: '/api/v1/sessions/sess-a/events', token: aliceToken });
    expect(own.status).toBe(200);
    expect(Array.isArray(own.body?.data)).toBe(true);
  });

  it('/sessions/:id/children 在闸内（子会话面板锚）：越域 404、同域 200 回子会话、缺失 404', async () => {
    await makeSession('parent-a', tenantA);
    await makeSession('parent-b', tenantB);
    // 委派子会话（spawnBy 归属，D7）：租户随父继承，可见性以父会话闸为准
    const now = Date.now();
    const child: SessionData = {
      id: 'child-a',
      agentId: 'host-agent',
      tenantId: tenantA as TenantId,
      meta: {
        id: 'child-a',
        agentId: 'host-agent',
        tenantId: tenantA as TenantId,
        channelId: 'web',
        peerId: 'ui',
        status: 'idle',
        createdAt: now,
        sessionStartedAt: now,
        lastInteractionAt: now,
        updatedAt: now,
      },
      messages: [],
      steps: [],
      metadata: {},
      spawnBy: {
        delegationId: 'del-1',
        parentAgentId: 'host-agent',
        parentSessionId: 'parent-a',
        parentRunId: 'run-1',
        depth: 1,
      },
    };
    await gateway['store'].save('child-a', child);

    const cross = await call(router, { method: 'GET', url: '/api/v1/sessions/parent-b/children', token: aliceToken });
    expect(cross.status).toBe(404);

    const own = await call(router, { method: 'GET', url: '/api/v1/sessions/parent-a/children', token: aliceToken });
    expect(own.status).toBe(200);
    const rows = (own.body?.data ?? []) as Array<{ id: string; spawnBy?: { parentSessionId: string } }>;
    expect(rows.map((c) => c.id)).toEqual(['child-a']);
    expect(rows[0].spawnBy?.parentSessionId).toBe('parent-a');

    // 缺失会话走端点自身 404 映射（host 面不经租户闸预检）
    const missing = await call(router, { method: 'GET', url: '/api/v1/sessions/nope/children' });
    expect(missing.status).toBe(404);
  });

  it('/debug/run/:id/* 同闸（MAJ-5 锚）：越域 404、同域 200', async () => {
    await makeSession('sess-a', tenantA);
    await makeSession('sess-b', tenantB);

    const cross = await call(router, { method: 'GET', url: '/debug/run/sess-b/scope', token: aliceToken });
    expect(cross.status).toBe(404);

    const own = await call(router, { method: 'GET', url: '/debug/run/sess-a/scope', token: aliceToken });
    expect(own.status).toBe(200);
  });

  it('POST /sessions 不得覆盖既有会话（MAJ-6 锚）：异租户劫持 409、同域幂等不丢正文', async () => {
    await makeSession('sess-b', tenantB);
    // 会话里放点正文，验证不被清空
    const data = await gateway['store'].load('sess-b');
    data!.messages.push({
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
    } as never);
    await gateway['store'].save('sess-b', data!);

    // 租户 A 拿已知 id 抢劫宿主/B 会话 → 409（不清正文、不过户）
    const hijack = await call(router, {
      method: 'POST',
      url: '/api/v1/sessions',
      token: aliceToken,
      body: { agentId: 'host-agent', sessionId: 'sess-b' },
    });
    expect(hijack.status).toBe(409);
    expect(hijack.body?.error).toMatch(/session_exists/);
    const after = await gateway['store'].load('sess-b');
    expect(after!.messages.length).toBe(1);
    expect(after!.meta.tenantId).toBe(tenantB);

    // 同域同 agent 重试 = 幂等（超时重发不炸、不丢数据）
    const retry = await call(router, {
      method: 'POST',
      url: '/api/v1/sessions',
      token: bobToken,
      body: { agentId: 'host-agent', sessionId: 'sess-b' },
    });
    expect(retry.status).toBe(201);
    expect((await gateway['store'].load('sess-b'))!.messages.length).toBe(1);
  });

  it('宿主面 POST 给 registry agent 建会话：归属盖章锚 agent 租户（MIN-5/MAJ-7-B 锚）', async () => {
    // root 为某租户 agent 建会话——会话归属应= agent 归属，而不是 default
    const registry = gateway.getRegistry()!;
    const alice = registry.resolveToken(aliceToken)!;
    const record = registry.createAgent({
      tenantId: alice.tenantId as never,
      ownerUserId: alice.userId as never,
      name: 'agent-a',
      definition: JSON.stringify({
        name: 'agent-a',
        description: '',
        model: 'mock/m',
        persona: { name: 'agent-a', description: '', systemPrompt: 'A_SYS' },
        tools: { allow: [] },
      }),
    });
    await gateway.attachRegistryAgent(record);

    const created = await call(router, {
      method: 'POST',
      url: '/api/v1/sessions',
      body: { agentId: record.agentId, sessionId: 'sess-agent-a' },
    });
    expect(created.status).toBe(201);
    const stored = await gateway['store'].load('sess-agent-a');
    expect(stored!.meta.tenantId).toBe(alice.tenantId);
  });
});
