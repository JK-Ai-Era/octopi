/**
 * run 事件流的「合法静默」回归锚。
 *
 * 事故形态：`timer_wait` 等长工具执行期间，run 的 NDJSON 流上没有任何字节。旧实现用
 * `fetch` 读流，而 Node 内置 undici 有硬编码 `bodyTimeout`（默认 300_000ms，见
 * undici/lib/dispatcher/client.js），它与「是否传 AbortSignal」无关——静默到 300s 就抛
 * `TypeError: terminated`。后果：300s 以上的 timer_wait 必死，报成 `[Gateway Error]
 * terminated`，且前端收不到 `tool.end`（表现为 timer 一直 running）。
 *
 * 这里把 300s 缩小成几百毫秒来复现同一机制：服务端先发一条事件，然后静默远超
 * undici 的 bodyTimeout 再发终态。断言：
 *   1) 旧路径（fetch）在同一服务上会失败（对照组，证明这个测试真的在测该机制）；
 *   2) 新路径（startRun）能跨过静默拿到终态。
 */

import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

/** 静默时长：远大于下面对照组设置的 bodyTimeout */
const SILENCE_MS = 1_500;

/**
 * 起一个最小 run 协议服务：一条事件 → 静默 → 终态。
 *
 * @returns 端口与关闭函数
 */
async function startQuietRunServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/runs') {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write('{"type":"event","event":{"type":"step_start","timestamp":1}}\n');
    // 工具执行中的合法静默
    setTimeout(() => {
      res.end(
        '{"type":"event","event":{"type":"step_end","timestamp":2}}\n{"type":"done"}\n',
      );
    }, SILENCE_MS).unref();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

describe('run 事件流的合法静默', () => {
  it('startRun 的传输能跨过远超任何「静默上限」的空档拿到终态', async () => {
    const srv = await startQuietRunServer();
    const { openRunEventStream, decodeRunStream } = await import(
      '../packages/gateway/src/gateway/remote-run-backend.js'
    );
    const { createStreamDispatcher } = await import(
      '../packages/engine/src/integration/providers/fetch-timeout.js'
    );
    // 与生产同一装配：providerFetch + 关闭 bodyTimeout 的 dispatcher
    const dispatcher = createStreamDispatcher(5_000);
    const events: string[] = [];
    try {
      const res = await openRunEventStream(srv.port, undefined, {
        sessionId: 's1',
        requestId: 'r1',
        message: { role: 'user', content: 'hi', timestamp: 0 },
      } as never, dispatcher);
      expect(res.ok).toBe(true);
      for await (const ev of decodeRunStream(res.body as unknown as AsyncIterable<Uint8Array>, 'test')) {
        events.push((ev as { type: string }).type);
      }
    } finally {
      await dispatcher.close();
      await srv.close();
    }
    expect(events).toEqual(['step_start', 'step_end']);
  });

  it('根因守卫：startRun 必须用 providerFetch + 关闭 bodyTimeout 的 dispatcher', async () => {
    // 机制已在纯 Node 脚本里实证：undici 的 bodyTimeout 默认为 300_000ms
    // (node_modules/undici/lib/dispatcher/client.js: `this[kBodyTimeout] = bodyTimeout != null ? bodyTimeout : 300e3`)，
    // 静默超过即抛 `TypeError: terminated`，且**与是否传 AbortSignal 无关**。
    // 这条守卫锁住修复本身，避免有人把它"简化"回裸 fetch 而静默复发。
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const relPath = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

    const src = readFileSync(relPath('../packages/gateway/src/gateway/remote-run-backend.ts'), 'utf8');
    const startRunBody = src.slice(
      src.indexOf('startRun(req: RunRequest)'),
      src.indexOf('   * 控制 op。'),
    );
    expect(startRunBody, 'startRun 应走 openRunEventStream').toContain('openRunEventStream(');
    expect(startRunBody, 'startRun 必须传 stream dispatcher').toContain('getStreamDispatcher()');

    // 传输函数本身：必须是 providerFetch（undici 自己的 fetch，才接受自定义 dispatcher）
    const transport = src.slice(
      src.indexOf('export async function openRunEventStream('),
      src.indexOf('export class RemoteRunBackend'),
    );
    expect(transport, 'openRunEventStream 必须用 providerFetch').toContain('providerFetch(');
    expect(transport, 'openRunEventStream 不得裸用 fetch').not.toMatch(/[^r]fetch\(/);
    expect(startRunBody, 'startRun 不得回到裸 fetchJson').not.toContain("fetchJson('POST'");

    // dispatcher 工厂本身必须禁用 bodyTimeout —— 否则等长静默仍会被 transport 掐断
    const factory = readFileSync(
      relPath('../packages/engine/src/integration/providers/fetch-timeout.ts'),
      'utf8',
    );
    const streamFactory = factory.slice(factory.indexOf('export function createStreamDispatcher('));
    expect(streamFactory, 'createStreamDispatcher 必须把 bodyTimeout 设为 0（禁用）').toMatch(
      /bodyTimeout:\s*0/,
    );
    expect(streamFactory, '仍要保留首字节预算').toMatch(/headersTimeout:\s*headersTimeoutMs/);
  });
});
