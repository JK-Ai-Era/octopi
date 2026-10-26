/**
 * web 面最小认证回归：
 * 1) WS 事件广播不过未认证 session（含 `*` 系统级广播）——审批卡与事件不漏给匿名连接；
 * 2) 审批署名取认证身份（approverIdentity 优先于客户端自报）。
 *
 * 规格：docs/KNOWN-ISSUES HITL 单模型段（审批归因可信度）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { HttpChannelAdapter } from '@octopi-agent/gateway/protocols/http.js';
import { WebApiRouter } from '@octopi-agent/gateway/web/api/router.js';

const PORT = 19191;

describe('WS 事件面未认证不漏（含 * 系统级广播）', () => {
  let adapter: HttpChannelAdapter | undefined;

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
  });

  it('未认证连接收不到广播、消息被拒；auth 后正常收', async () => {
    adapter = new HttpChannelAdapter({
      port: PORT,
      host: '127.0.0.1',
      path: '/messages',
      apiKey: 'k-test',
      enableWebSocket: true,
    });
    await adapter.start(async () => {});

    const anon = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const authed = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const anonGot: string[] = [];
    const authedGot: string[] = [];
    anon.on('message', (d) => anonGot.push(String(d)));
    authed.on('message', (d) => authedGot.push(String(d)));

    await new Promise<void>((resolve) => {
      let opened = 0;
      const onOpen = (): void => {
        opened += 1;
        if (opened === 2) resolve();
      };
      anon.on('open', onOpen);
      authed.on('open', onOpen);
    });

    // 未认证发消息 → 拒绝；另一条送 auth
    anon.send(JSON.stringify({ type: 'subscribe', sessionId: 's1' }));
    authed.send(JSON.stringify({ type: 'auth', token: 'k-test' }));
    await new Promise((r) => setTimeout(r, 150));

    adapter.broadcastEvent('*', { type: 'sys.ping', timestamp: Date.now() } as never);
    await new Promise((r) => setTimeout(r, 250));

    expect(anonGot.some((m) => m.includes('sys.ping'))).toBe(false);
    expect(anonGot.some((m) => m.includes('Unauthorized'))).toBe(true);
    expect(authedGot.some((m) => m.includes('sys.ping'))).toBe(true);

    anon.close();
    authed.close();
  }, 15_000);
});

describe('审批署名取认证身份（credential-backed）', () => {
  it('approverIdentity 优先于客户端自报署名', async () => {
    let seenApprover: string | undefined;
    const router = new WebApiRouter({
      gateway: {
        resolvePendingApproval: (_id: string, input: { approver?: string }) => {
          seenApprover = input.approver;
          return { id: 'a1', status: 'approved' };
        },
      } as never,
      basePath: '/api/v1',
      approverIdentity: 'owner',
    });

    const chunks: string[] = [];
    const req = {
      method: 'POST',
      url: '/api/v1/approvals/a1',
      headers: { host: 'localhost' },
      async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
        yield Buffer.from(JSON.stringify({ action: 'approve', approver: 'mallory' }));
      },
    } as unknown as IncomingMessage;
    const res = {
      setHeader: (): void => undefined,
      writeHead: (): void => undefined,
      end: (body?: string): void => {
        if (body) chunks.push(body);
      },
    } as unknown as ServerResponse;

    const handled = await router.handle(req, res);
    expect(handled).toBe(true);
    expect(seenApprover).toBe('owner');
  });

  it('无认证部署（approverIdentity 缺省）退回客户端自报（现状语义）', async () => {
    let seenApprover: string | undefined;
    const router = new WebApiRouter({
      gateway: {
        resolvePendingApproval: (_id: string, input: { approver?: string }) => {
          seenApprover = input.approver;
          return { id: 'a1', status: 'approved' };
        },
      } as never,
      basePath: '/api/v1',
    });

    const req = {
      method: 'POST',
      url: '/api/v1/approvals/a1',
      headers: { host: 'localhost' },
      async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
        yield Buffer.from(JSON.stringify({ action: 'approve', approver: 'self-report' }));
      },
    } as unknown as IncomingMessage;
    const res = {
      setHeader: (): void => undefined,
      writeHead: (): void => undefined,
      end: (): void => undefined,
    } as unknown as ServerResponse;

    await router.handle(req, res);
    expect(seenApprover).toBe('self-report');
  });
});
