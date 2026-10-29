/**
 * WS 认证契约 — GatewayChatClient ↔ HttpChannelAdapter
 *
 * 核心回归：channels.http.apiKey 开启鉴权后，客户端连接须首条消息送 auth。
 * TUI 曾因未把 apiKey 交给 GatewayChatClient（只传 url），发消息即被鉴权门
 * 拒绝：「Unauthorized: send auth message first」。本套件钉住两端契约——
 * 客户端有钥先 auth、服务端无钥拒 chat——任何一端再掉链子都会红。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { HttpChannelAdapter } from '@octopi-agent/gateway/protocols/http.js';
import { GatewayChatClient } from '@octopi-agent/gateway/gateway/client.js';

interface TestAdapter {
  adapter: HttpChannelAdapter;
  port: number;
  received: Array<{ content?: unknown }>;
}

const started: HttpChannelAdapter[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((a) => a.stop()));
});

async function startAdapter(apiKey?: string): Promise<TestAdapter> {
  const adapter = new HttpChannelAdapter({
    port: 0,
    host: '127.0.0.1',
    path: '/messages',
    enableWebSocket: true,
    apiKey,
  } as never);
  started.push(adapter);
  const received: Array<{ content?: unknown }> = [];
  await adapter.start(async (msg) => {
    received.push(msg as { content?: unknown });
  });
  const server = (adapter as unknown as { server: { address(): { port: number } | null } }).server;
  return { adapter, port: server.address()!.port, received };
}

describe('WS auth 契约（GatewayChatClient ↔ HttpChannelAdapter）', () => {
  it('apiKey 开启后：带钥客户端首条消息送 auth，chat 可达 handler', async () => {
    const { port, received } = await startAdapter('secret');
    const client = new GatewayChatClient({ url: `http://127.0.0.1:${port}`, apiKey: 'secret' });
    const errors: string[] = [];
    client.on({ onError: (e) => errors.push(e.message) });

    await client.connect();
    await client.sendMessage('hello', 's-1', 'a1');

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.content).toBe('hello');
    expect(errors).toEqual([]);
    client.disconnect();
  });

  it('未带 apiKey 的客户端（TUI 旧行为）：chat 被鉴权门拒绝且不达 handler', async () => {
    const { port, received } = await startAdapter('secret');
    const client = new GatewayChatClient({ url: `http://127.0.0.1:${port}` });
    const errors: string[] = [];
    client.on({ onError: (e) => errors.push(e.message) });

    await client.connect();
    await client.sendMessage('hello', 's-1', 'a1');

    await vi.waitFor(() =>
      expect(errors).toContain('Unauthorized: send auth message first'),
    );
    expect(received).toHaveLength(0);
    client.disconnect();
  });

  it('token 不符：报 invalid token 并断开连接', async () => {
    const { port, received } = await startAdapter('secret');
    const client = new GatewayChatClient({ url: `http://127.0.0.1:${port}`, apiKey: 'wrong' });
    const errors: string[] = [];
    let disconnected = false;
    client.on({
      onError: (e) => errors.push(e.message),
      onDisconnected: () => {
        disconnected = true;
      },
    });

    await client.connect();

    await vi.waitFor(() => expect(errors).toContain('Unauthorized: invalid token'));
    await vi.waitFor(() => expect(disconnected).toBe(true));
    expect(received).toHaveLength(0);
    client.disconnect();
  });

  it('无鉴权（未配 apiKey）：不送 auth 也可 chat', async () => {
    const { port, received } = await startAdapter(undefined);
    const client = new GatewayChatClient({ url: `http://127.0.0.1:${port}` });
    const errors: string[] = [];
    client.on({ onError: (e) => errors.push(e.message) });

    await client.connect();
    await client.sendMessage('hello', 's-1', 'a1');

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.content).toBe('hello');
    expect(errors).toEqual([]);
    client.disconnect();
  });
});
