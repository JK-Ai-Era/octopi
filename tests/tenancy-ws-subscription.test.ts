/**
 * T4b WS 订阅租户闸（arch/multi-tenancy.md §9.1-3）：
 * auth 消息可附带 registryToken 转租户身份连接——此后 session/agent 订阅受租户收口；
 * 坏 registryToken fail-loud 拒连；无 registryToken = 宿主面（存量语义）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';

import { HttpChannelAdapter } from '@octopi-agent/gateway/protocols/http.js';
import { createWsIdentityHooks } from '../src/ws-identity-hooks.js';

const PORT = 19192;

/** 测试归属表（deps 读口）——hook 实现走 daemon 同款工厂（评审方法论：不自造 seam） */
const sessionTenants: Record<string, string> = { 'sess-a': 'tA', 'sess-b': 'tB' };
const agentTenants: Record<string, string | undefined> = { 'agent-a': 'tA', 'agent-b': 'tB', 'host-agent': undefined };

function openClient(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve) => ws.on('open', () => resolve(ws)));
}

function waitFor(ws: WebSocket, pred: (msg: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ws frame')), 3000);
    const onMessage = (d: WebSocket.Data): void => {
      const text = String(d);
      if (pred(text)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(text);
      }
    };
    ws.on('message', onMessage);
  });
}

describe('WS 订阅租户闸（§9.1-3）', () => {
  let adapter: HttpChannelAdapter | undefined;

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
  });

  function makeAdapter(): HttpChannelAdapter {
    const hooks = createWsIdentityHooks({
      resolveToken: (token) => (token === 'tok-alice' ? { tenantId: 'tA', isPlatformAdmin: false } : null),
      getSessionTenant: async (sessionId) => sessionTenants[sessionId],
      getAgentTenant: (agentId) => agentTenants[agentId],
    });
    const next = new HttpChannelAdapter({
      port: PORT,
      host: '127.0.0.1',
      path: '/messages',
      apiKey: 'k-test',
      enableWebSocket: true,
      ...hooks,
    });
    adapter = next;
    return next;
  }

  it('registryToken 转租户身份连接：同域订阅放行、越域订阅拒收明示', async () => {
    await makeAdapter().start(async () => {});
    const ws = await openClient(`ws://127.0.0.1:${PORT}/ws`);

    ws.send(JSON.stringify({ type: 'auth', token: 'k-test', registryToken: 'tok-alice' }));
    const authFrame = await waitFor(ws, (m) => m.includes('auth_ok'));
    expect(authFrame).toContain('tenantScoped');

    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'sess-a' }));
    await waitFor(ws, (m) => m.includes('"subscribed"') && m.includes('sess-a'));

    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'sess-b' }));
    const denied = await waitFor(ws, (m) => m.includes('outside your tenant'));
    expect(denied).toContain('sess-b');

    ws.send(JSON.stringify({ type: 'subscribe', agentId: 'agent-b' }));
    await waitFor(ws, (m) => m.includes('outside your tenant') && m.includes('agent-b'));

    ws.send(JSON.stringify({ type: 'subscribe', agentId: 'agent-a' }));
    await waitFor(ws, (m) => m.includes('"subscribed"') && m.includes('agent-a'));
    ws.close();
  });

  it('坏 registryToken fail-loud 拒连（不静默落宿主面）', async () => {
    await makeAdapter().start(async () => {});
    const ws = await openClient(`ws://127.0.0.1:${PORT}/ws`);
    ws.send(JSON.stringify({ type: 'auth', token: 'k-test', registryToken: 'tok-bogus' }));
    const frame = await waitFor(ws, (m) => m.includes('invalid registryToken'));
    expect(frame).toContain('error');
  });

  it('chat 携他租户 agentId：拒收且不改写连接身份（MAJ-4 锚）', async () => {
    const next = makeAdapter();
    await next.start(async () => {});
    const ws = await openClient(`ws://127.0.0.1:${PORT}/ws`);
    ws.send(JSON.stringify({ type: 'auth', token: 'k-test', registryToken: 'tok-alice' }));
    await waitFor(ws, (m) => m.includes('auth_ok'));

    // 指向他租户 agent 的 chat：拒收（不投递、不把 agentId 写进匹配面）
    ws.send(JSON.stringify({ type: 'chat', agentId: 'agent-b', sessionId: 'sess-a', content: 'hi', senderId: 'u' }));
    const denied = await waitFor(ws, (m) => m.includes('chat target is outside your tenant'));
    expect(denied).toContain('error');

    // 他租户 agent 的实时事件不得因那帧 chat 流入
    const got: string[] = [];
    ws.on('message', (d) => got.push(String(d)));
    next.broadcastEvent('sess-x', { type: 'test.leak', timestamp: Date.now() } as never, 'agent-b');
    await new Promise((r) => setTimeout(r, 250));
    expect(got.some((m) => m.includes('test.leak'))).toBe(false);

    // 同域 chat 照常
    ws.send(JSON.stringify({ type: 'chat', agentId: 'agent-a', content: 'hi', senderId: 'u' }));
    await new Promise((r) => setTimeout(r, 100));
    ws.close();
  });

  it('chat 自动订阅同过租户闸：越域 sessionId 不进事件流（自审修复锚）', async () => {
    const next = makeAdapter();
    await next.start(async () => {});
    const ws = await openClient(`ws://127.0.0.1:${PORT}/ws`);
    ws.send(JSON.stringify({ type: 'auth', token: 'k-test', registryToken: 'tok-alice' }));
    await waitFor(ws, (m) => m.includes('auth_ok'));

    ws.send(JSON.stringify({ type: 'chat', sessionId: 'sess-b', content: 'hi', senderId: 'u' }));
    ws.send(JSON.stringify({ type: 'chat', sessionId: 'sess-a', content: 'hi', senderId: 'u' }));
    await new Promise((r) => setTimeout(r, 200));

    const got: string[] = [];
    ws.on('message', (d) => got.push(String(d)));
    next.broadcastEvent('sess-b', { type: 'test.ping', timestamp: Date.now() } as never);
    next.broadcastEvent('sess-a', { type: 'test.pong', timestamp: Date.now() } as never);
    await new Promise((r) => setTimeout(r, 250));
    expect(got.some((m) => m.includes('test.ping'))).toBe(false);
    expect(got.some((m) => m.includes('test.pong'))).toBe(true);
    ws.close();
  });

  it('无 registryToken = 宿主面（存量语义不变）', async () => {
    await makeAdapter().start(async () => {});
    const ws = await openClient(`ws://127.0.0.1:${PORT}/ws`);
    ws.send(JSON.stringify({ type: 'auth', token: 'k-test' }));
    const authFrame = await waitFor(ws, (m) => m.includes('auth_ok'));
    expect(authFrame).not.toContain('tenantScoped');

    // 宿主面订阅不受租户闸（canSubscribe 不介入）
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'sess-b' }));
    await waitFor(ws, (m) => m.includes('"subscribed"') && m.includes('sess-b'));
    ws.close();
  });
});
