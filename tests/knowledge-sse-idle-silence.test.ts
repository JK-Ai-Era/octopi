/**
 * Knowledge SSE 进度订阅的「合法静默」回归锚。
 *
 * 与 `run-stream-idle-silence.test.ts` 同因：订阅是长连接 SSE，没有 ingest 任务时事件
 * 之间无数据。旧实现用裸 `fetch` 读流，Node 内置 undici 的 `bodyTimeout` 默认
 * 300_000ms（`undici/lib/dispatcher/client.js`：`bodyTimeout != null ? bodyTimeout : 300e3`），
 * 静默到点抛 `TypeError: terminated`，随后被 `catch` 吞掉 —— 订阅无声死掉、静默退化成
 * stats 轮询。
 *
 * 另外锁住两件事：主动取消（dispose）不得触发告警；真断线必须留痕。
 */

import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SILENCE_MS = 1_200;

/**
 * 起一个最小 SSE 服务：发一帧 → 静默 → 再发一帧后挂住（长连接不主动结束）。
 *
 * @returns 端口、收到的连接数、关闭函数
 */
async function startSseServer(): Promise<{
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}> {
  let connections = 0;
  const server = createServer((req, res) => {
    connections += 1;
    if (!req.url?.endsWith('/v1/events')) {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: progress\ndata: {"stage":"first"}\n\n');
    setTimeout(() => {
      res.write('event: progress\ndata: {"stage":"after-silence"}\n\n');
      // 不结束：真实 SSE 是长连接
    }, SILENCE_MS).unref();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

describe('Knowledge SSE 订阅的合法静默', () => {
  it('根因守卫：订阅必须用 providerFetch + 关闭 bodyTimeout 的 dispatcher', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../packages/gateway/src/gateway/knowledge-runtime.ts', import.meta.url)),
      'utf8',
    );
    const body = src.slice(
      src.indexOf('async subscribeProgress('),
      src.indexOf('return () => ac.abort();'),
    );
    expect(body, 'subscribeProgress 必须用 providerFetch').toContain('providerFetch(');
    expect(body, 'subscribeProgress 必须传 stream dispatcher').toContain('dispatcher');
    expect(body, 'subscribeProgress 不得裸用 fetch').not.toMatch(/[^r]fetch\(/);
    // 主动取消与真断线必须可区分（否则降级路径永远看不见）
    expect(body, '必须区分主动取消').toContain('ac.signal.aborted');
  });

  it('能跨过远超 undici 默认静默阈值的空档收到后续事件', async () => {
    const srv = await startSseServer();
    // 与生产同一装配：providerFetch + 关闭 bodyTimeout 的 dispatcher
    const { providerFetch, createStreamDispatcher } = await import(
      '../packages/engine/src/integration/providers/fetch-timeout.js'
    );
    const dispatcher = createStreamDispatcher(5_000);
    const stages: string[] = [];
    try {
      const res = await providerFetch(`http://127.0.0.1:${srv.port}/v1/events`, {
        headers: { accept: 'text/event-stream' },
        dispatcher,
      } as Parameters<typeof providerFetch>[1]);
      expect(res.ok).toBe(true);

      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let buf = '';
      let stop = false;
      while (!stop) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          stages.push((JSON.parse(dataLine.slice(6)) as { stage: string }).stage);
          if (stages.length === 2) stop = true;
        }
      }
      await reader.cancel().catch(() => undefined);
    } finally {
      await dispatcher.close();
      await srv.close();
    }
    // 关键：第二条事件在 1.2s 静默之后 —— 若 transport 有静默上限就会拿不到
    expect(stages).toEqual(['first', 'after-silence']);
  });
});
