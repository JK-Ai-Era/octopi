/**
 * OctopiClient 鉴权失败契约（旧凭据被拒不得死循环重连的回归锚）。
 *
 * 锚定行为：
 * 1. WS close 4001（网关鉴权拒绝）→ 停止自动重连（不再死循环「正在重连」）；
 *    状态 failed；上报失效凭据（credential 机器可读优先、文案分类兜底）。
 * 2. 普通断线（非 4001）→ 仍自动重连（不回归）。
 * 3. HTTP 401 → 上报鉴权失败并透传异常。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OctopiClient,
  classifyAuthFailure,
  setAuthFailureHandler,
  type AuthFailureInfo,
} from '@octopi-agent/gateway/web/sdk/client.js';

/** 浏览器 WebSocket 的最小替身（open/message/close 可编排） */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Array<(e: unknown) => void>>();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  private emit(type: string, event: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  simulateMessage(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  simulateClose(code: number): void {
    this.readyState = 3;
    this.emit('close', { code });
  }
}

function makeClient(over: { apiKey?: string; registryToken?: string } = {}): {
  client: OctopiClient;
  failures: AuthFailureInfo[];
} {
  const failures: AuthFailureInfo[] = [];
  const client = new OctopiClient({
    baseUrl: 'http://gateway.test',
    apiKey: over.apiKey,
    registryToken: over.registryToken,
  });
  client.on({ onAuthFailure: (info) => failures.push(info) });
  return { client, failures };
}

describe('classifyAuthFailure', () => {
  it('机器可读 credential 提示优先', () => {
    expect(classifyAuthFailure('whatever', 'registryToken')).toBe('registryToken');
    expect(classifyAuthFailure('whatever', 'apiKey')).toBe('apiKey');
  });

  it('文案分类兜底（HTTP body / 旧网关 WS 文案）', () => {
    expect(classifyAuthFailure('HTTP 401: unauthorized: invalid X-Registry-Token')).toBe('registryToken');
    expect(classifyAuthFailure('Unauthorized: invalid registryToken')).toBe('registryToken');
    expect(classifyAuthFailure('HTTP 401: Unauthorized: invalid or missing API key')).toBe('apiKey');
    expect(classifyAuthFailure('Unauthorized: invalid token')).toBe('apiKey');
    expect(classifyAuthFailure('HTTP 500: boom')).toBe('unknown');
  });
});

describe('OctopiClient WS 鉴权失败', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setAuthFailureHandler(null);
  });

  it('close 4001 → 停止重连、状态 failed、上报失效凭据', () => {
    const { client, failures } = makeClient({ apiKey: 'bad-key' });
    client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage({ type: 'error', message: 'Unauthorized: invalid token', credential: 'apiKey' });
    ws.simulateClose(4001);

    expect(client.getConnectionState()).toBe('failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      reason: 'apiKey',
      source: 'ws',
      failedApiKey: 'bad-key',
    });
    // 不再重连：推进调度窗口后没有新连接
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('close 4001 无前置 error 文案 → 按 unknown 上报（仍停重连）', () => {
    const { client, failures } = makeClient({ apiKey: 'bad-key' });
    client.connect();
    FakeWebSocket.instances[0]!.simulateOpen();
    FakeWebSocket.instances[0]!.simulateClose(4001);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toBe('unknown');
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('registryToken 被拒（credential 提示）→ reason=registryToken', () => {
    const { client, failures } = makeClient({ registryToken: 'stale-token' });
    client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage({
      type: 'error',
      message: 'Unauthorized: invalid registryToken',
      credential: 'registryToken',
    });
    ws.simulateClose(4001);
    expect(failures[0]).toMatchObject({ reason: 'registryToken', failedRegistryToken: 'stale-token' });
  });

  it('普通断线（非 4001）→ 仍自动重连（不回归）', () => {
    const { client, failures } = makeClient({ apiKey: 'k' });
    client.connect();
    FakeWebSocket.instances[0]!.simulateOpen();
    FakeWebSocket.instances[0]!.simulateClose(1006);
    expect(client.getConnectionState()).toBe('reconnecting');
    expect(failures).toHaveLength(0);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
  });

  it('全局处理器与实例监听器同时收到上报', () => {
    const globalSeen: AuthFailureInfo[] = [];
    setAuthFailureHandler((info) => globalSeen.push(info));
    const { client, failures } = makeClient({ apiKey: 'bad-key' });
    client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage({ type: 'error', message: 'Unauthorized: invalid token', credential: 'apiKey' });
    ws.simulateClose(4001);
    expect(globalSeen).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });
});

describe('OctopiClient HTTP 鉴权失败', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setAuthFailureHandler(null);
  });

  it('HTTP 401 → 上报鉴权失败并透传异常', async () => {
    const globalSeen: AuthFailureInfo[] = [];
    setAuthFailureHandler((info) => globalSeen.push(info));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: 'unauthorized: invalid X-Registry-Token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const { client, failures } = makeClient({ registryToken: 'stale-token' });
    await expect(client.getBrowserEngines()).rejects.toThrow(/HTTP 401/);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ reason: 'registryToken', source: 'http', failedRegistryToken: 'stale-token' });
    expect(globalSeen).toHaveLength(1);
  });

  it('成功响应不上报鉴权失败', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const { client, failures } = makeClient();
    await client.getBrowserEngines();
    expect(failures).toHaveLength(0);
  });

  it('fetchSessionFile 的 401 也上报鉴权失败（字节流面不留归因缺口）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: 'Unauthorized: invalid or missing API key' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const { client, failures } = makeClient({ apiKey: 'stale' });
    const res = await client.fetchSessionFile('s1', 'f1');
    expect(res.status).toBe(401); // Response 原样交调用方，只补归因
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ reason: 'apiKey', source: 'http', baseUrl: 'http://gateway.test' });
  });
});
