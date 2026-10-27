/**
 * OP-WEB-1 WS 广播路由 — agentId 显式携带（不再从 sessionKey 猜测）
 *
 * 核心回归：Web 会话 key 是裸 sessionId，`split(':')[0]` 永远匹配不上连接身份；
 * 修复后 agent 维度广播对裸 sessionId 生效，客户端可撤掉批量精确订阅绕法。
 */

import { describe, it, expect } from 'vitest';
import { HttpChannelAdapter } from '@octopi-agent/gateway/protocols/http.js';

type FakeWsSession = {
  ws: { readyState: number; bufferedAmount: number; send: (s: string) => void };
  authenticated: boolean;
  sessionId?: string;
  agentId?: string;
  subscribedSessions?: Set<string>;
  subscribedAgents?: Set<string>;
  sendQueue: string[];
  draining: boolean;
};

function makeAdapter(): HttpChannelAdapter {
  return new HttpChannelAdapter({
    port: 0,
    host: '127.0.0.1',
    path: '/chat',
    enableWebSocket: true,
  } as never);
}

function makeWsSession(): { session: FakeWsSession; sent: string[] } {
  const sent: string[] = [];
  const session: FakeWsSession = {
    // 1 = WebSocket.OPEN
    ws: { readyState: 1, bufferedAmount: 0, send: (s: string) => sent.push(s) },
    authenticated: true,
    sendQueue: [],
    draining: false,
  };
  return { session, sent };
}

function attach(adapter: HttpChannelAdapter, session: FakeWsSession): void {
  (adapter as unknown as { wsSessions: Set<FakeWsSession> }).wsSessions.add(session);
}

function handleWsMessage(adapter: HttpChannelAdapter, session: FakeWsSession, msg: unknown): Promise<void> {
  return (
    adapter as unknown as {
      handleWsMessage(s: FakeWsSession, m: unknown): Promise<void>;
    }
  ).handleWsMessage(session, msg);
}

// 合成事件用仍在派生 state 帧的类型（llm_stream_delta → running）：
// 本套件主题是路由计数；turn.end 不再派生 state 是 F4 契约，见下方独立用例
const ev = (sessionId: string, agentId?: string) =>
  ({ type: 'llm_stream_delta', sessionId, timestamp: 1, data: { delta: 'x' } , ...(agentId ? { agentId } : {}) }) as never;

describe('broadcastEvent agent 维度路由（OP-WEB-1）', () => {
  it('turn.end 不再派生 state 帧；idle 只由 engine.end 派生（评审 F4）', () => {
    const adapter = makeAdapter();
    const { session, sent } = makeWsSession();
    session.sessionId = 's-1';
    session.agentId = 'a1';
    attach(adapter, session);
    adapter.broadcastEvent('s-1', { type: 'turn.end', sessionId: 's-1', timestamp: 1, data: {} } as never, 'a1');
    expect(sent).toHaveLength(1); // 仅 event 帧，无 state
    adapter.broadcastEvent('s-1', { type: 'engine.end', sessionId: 's-1', timestamp: 1, data: {} } as never, 'a1');
    expect(sent).toHaveLength(3); // + event + state(idle)
    expect(sent[2]).toContain('"state":"idle"');
  });

  it('agent 维度订阅命中裸 sessionId 会话事件（旧 split 口径从不命中）', async () => {
    const adapter = makeAdapter();
    const { session, sent } = makeWsSession();
    attach(adapter, session);
    await handleWsMessage(adapter, session, { type: 'subscribe', agentId: 'a1' });

    adapter.broadcastEvent('web-session-1', ev('web-session-1', 'a1'), 'a1');

    expect(sent).toHaveLength(3); // subscribed ack + event + state
  });

  it('显式 agentId 与订阅不匹配时不投递', () => {
    const adapter = makeAdapter();
    const { session, sent } = makeWsSession();
    session.subscribedAgents = new Set(['a1']);
    attach(adapter, session);

    adapter.broadcastEvent('web-session-2', ev('web-session-2', 'a2'), 'a2');

    expect(sent).toHaveLength(0);
  });

  it('agent 订阅集命中任意该 agent 会话（替代批量精确订阅）', () => {
    const adapter = makeAdapter();
    const { session, sent } = makeWsSession();
    session.subscribedAgents = new Set(['a1']);
    attach(adapter, session);

    adapter.broadcastEvent('s-x', ev('s-x', 'a1'), 'a1');
    adapter.broadcastEvent('s-y', ev('s-y', 'a1'), 'a1');
    adapter.broadcastEvent('s-z', ev('s-z', 'a2'), 'a2');

    expect(sent).toHaveLength(4); // s-x + s-y 各 event+state
  });

  it('精确订阅路由不变（当前会话）', () => {
    const adapter = makeAdapter();
    const { session, sent } = makeWsSession();
    session.subscribedSessions = new Set(['s-cur']);
    attach(adapter, session);

    adapter.broadcastEvent('s-cur', ev('s-cur', 'a1'), 'a1');
    adapter.broadcastEvent('s-other', ev('s-other', 'a1'), 'a1');

    expect(sent).toHaveLength(2);
  });

  it('agentId 缺省时回落 event.agentId（合成事件自带 agentId 亦可路由）', () => {
    const adapter = makeAdapter();
    const { session, sent } = makeWsSession();
    session.subscribedAgents = new Set(['a1']);
    attach(adapter, session);

    adapter.broadcastEvent('s-fb', ev('s-fb', 'a1'));

    expect(sent).toHaveLength(2);
  });

  it('agentId 与 event.agentId 皆无时仅精确订阅可达', () => {
    const adapter = makeAdapter();
    const { session, sent } = makeWsSession();
    session.subscribedAgents = new Set(['a1']);
    attach(adapter, session);

    adapter.broadcastEvent('s-none', ev('s-none'));

    expect(sent).toHaveLength(0);
  });

  it("'*' 系统级广播送达全部连接", () => {
    const adapter = makeAdapter();
    const { session, sent } = makeWsSession();
    attach(adapter, session);

    adapter.broadcastEvent('*', ev('*'));

    expect(sent).toHaveLength(1); // 无 state 派生
  });
});

describe('subscribe 协议：agent 维度（OP-WEB-1 撤批量订阅的前提）', () => {
  it('subscribe {agentId} 记入订阅集且不改写连接身份（无漂移）', async () => {
    const adapter = makeAdapter();
    const { session, sent } = makeWsSession();
    session.agentId = 'keep';
    attach(adapter, session);

    await handleWsMessage(adapter, session, { type: 'subscribe', agentId: 'a1' });

    expect(session.subscribedAgents?.has('a1')).toBe(true);
    // 连接身份不被订阅改写——旧批量订阅带 agentId 会随列表末条漂移的根因
    expect(session.agentId).toBe('keep');
    expect(sent.some((s) => s.includes('"subscribed"'))).toBe(true);
  });

  it('subscribe {sessionId, agentId} 仍为精确订阅 + 身份绑定（TUI/chat 语义不变）', async () => {
    const adapter = makeAdapter();
    const { session } = makeWsSession();
    attach(adapter, session);

    await handleWsMessage(adapter, session, { type: 'subscribe', sessionId: 's1', agentId: 'a1' });

    expect(session.subscribedSessions?.has('s1')).toBe(true);
    expect(session.subscribedAgents?.has('a1') ?? false).toBe(false);
    expect(session.agentId).toBe('a1');
  });

  it('unsubscribe {agentId} 移除 agent 维度订阅', async () => {
    const adapter = makeAdapter();
    const { session, sent } = makeWsSession();
    session.subscribedAgents = new Set(['a1']);
    attach(adapter, session);

    await handleWsMessage(adapter, session, { type: 'unsubscribe', agentId: 'a1' });
    adapter.broadcastEvent('s-x', ev('s-x', 'a1'), 'a1');

    expect(session.subscribedAgents?.has('a1')).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
