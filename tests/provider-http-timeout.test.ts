/**
 * Provider HTTP transport 超时对齐（fetch-timeout）契约
 *
 * 事故（2026-10-27）：Node 内置 fetch（undici）的 headersTimeout / bodyTimeout
 * 默认各 300s，不受 provider `timeoutSeconds` 影响——非流式 chat 一次超过 300s
 * 的正常长生成（实测 380–447s）必被 transport 掐死成 `TypeError: fetch failed`，
 * sync fallback 对长生成模型恢复率为 0。修复 = provider 用 undici 自带 fetch +
 * 显式 dispatcher，transport 两级超时对齐 provider 自身 `timeoutMs`。
 *
 * 本测试锁三件事：
 * 1. dispatcher 的 headers/body 超时真的管住 fetch（真实慢服务器）；
 * 2. 两个 provider 的 chat/stream 都经由该 dispatcher 发出（记录型 Agent）；
 * 3. provider 级超时真的管住整次调用。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import {
  createTimeoutDispatcher,
  providerFetch,
} from '@octopi-agent/engine/integration/providers/fetch-timeout.js';
import { AnthropicProvider } from '@octopi-agent/engine/integration/providers/anthropic.js';
import { OpenAIProvider } from '@octopi-agent/engine/integration/providers/openai.js';

interface LocalServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * 启动本地 HTTP 服务器
 *
 * @param handler - 请求处理器
 * @returns 服务器地址与关闭句柄
 */
async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LocalServer> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * 延迟响应的服务器
 *
 * @param delayMs - 响应延迟（毫秒）
 * @param flushHeadersFirst - true 时先发响应头、延迟后再发正文（测 bodyTimeout）
 * @returns 服务器句柄
 */
function slowServer(delayMs: number, flushHeadersFirst = false): Promise<LocalServer> {
  return startServer((_req, res) => {
    if (flushHeadersFirst) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      setTimeout(() => res.end('{"ok":true}'), delayMs);
    } else {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }, delayMs);
    }
  });
}

/** 记录 dispatch 调用的 Agent：证明 provider 的 HTTP 真的走了注入的 dispatcher */
class RecordingAgent extends Agent {
  dispatchCalls = 0;

  override dispatch(...args: Parameters<Agent['dispatch']>): ReturnType<Agent['dispatch']> {
    this.dispatchCalls += 1;
    return super.dispatch(...args);
  }
}

/**
 * 按请求体是否 stream 返回 JSON / SSE 的 stub 服务（覆盖 anthropic 与 openai 两种响应形态）
 *
 * @returns 服务器句柄
 */
function stubModelServer(): Promise<LocalServer> {
  return startServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let stream = false;
      try {
        stream = Boolean(JSON.parse(Buffer.concat(chunks).toString('utf8')).stream);
      } catch {
        stream = false;
      }
      if (!stream) {
        const body = req.url?.includes('/v1/messages')
          ? {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'm1',
              content: [{ type: 'text', text: 'hi' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 2 },
            }
          : {
              id: 'cmpl-1',
              model: 'm1',
              choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 2 },
            };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (req.url?.includes('/v1/messages')) {
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      } else {
        res.write('data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        res.write('data: [DONE]\n\n');
      }
      res.end();
    });
  });
}

describe('createTimeoutDispatcher 管住 fetch 的两级超时', () => {
  const open: LocalServer[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  it('headers 迟于 dispatcher 超时 → 请求失败（默认 300s 头部超时不再兜底）', async () => {
    // undici 的超时计时器有亚秒级合并迟滞，小比例不可靠；用 100ms 配置对 4s 延迟的比例
    const server = await slowServer(4_000);
    open.push(server);
    const dispatcher = createTimeoutDispatcher(100);

    // 裸 fetch 的 headersTimeout 默认 300s，会等满 4s 成功；
    // 挂上 dispatcher 后必须提前失败——这正是「超时对齐配置值」的证明
    await expect(providerFetch(`${server.url}/`, { dispatcher })).rejects.toThrow();
    await dispatcher.close();
  });

  it('headers 在窗口内 → 成功（正对照：排除互操作假阳性）', async () => {
    const server = await slowServer(50);
    open.push(server);
    const dispatcher = createTimeoutDispatcher(5_000);

    const res = await providerFetch(`${server.url}/`, { dispatcher });
    expect(res.ok).toBe(true);
    await res.json();
    await dispatcher.close();
  });

  it('正文迟于 bodyTimeout → 请求失败', async () => {
    const server = await slowServer(4_000, true);
    open.push(server);
    const dispatcher = createTimeoutDispatcher(100);

    // fetch 在响应头到达时即 resolve；bodyTimeout 管的是正文读取阶段
    await expect(
      providerFetch(`${server.url}/`, { dispatcher }).then((res) => res.text()),
    ).rejects.toThrow();
    await dispatcher.close();
  });
});

describe('provider 的 HTTP 经由对齐超时的 dispatcher 发出', () => {
  const open: LocalServer[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  it('AnthropicProvider chat/stream 都走注入的 dispatcher', async () => {
    const server = await stubModelServer();
    open.push(server);
    const recorder = new RecordingAgent({ headersTimeout: 5_000, bodyTimeout: 5_000 });
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: server.url, models: ['m1'] });
    (provider as unknown as { dispatcher: Agent }).dispatcher = recorder;

    const response = await provider.chat({ messages: [] });
    expect(response.content).toBe('hi');
    const chunks: unknown[] = [];
    for await (const chunk of provider.stream({ messages: [] })) chunks.push(chunk);

    expect(recorder.dispatchCalls).toBe(2);
    await recorder.close();
  });

  it('OpenAIProvider chat/stream 都走注入的 dispatcher', async () => {
    const server = await stubModelServer();
    open.push(server);
    const recorder = new RecordingAgent({ headersTimeout: 5_000, bodyTimeout: 5_000 });
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: server.url, models: ['m1'] });
    (provider as unknown as { dispatcher: Agent }).dispatcher = recorder;

    const response = await provider.chat({ messages: [] });
    expect(response.content).toBe('hi');
    const chunks: unknown[] = [];
    for await (const chunk of provider.stream({ messages: [] })) chunks.push(chunk);

    expect(recorder.dispatchCalls).toBe(2);
    await recorder.close();
  });

  it('provider 级 timeoutMs 管住整次调用（错误形态=自身计时 abort，不是 transport 超时）', async () => {
    const server = await slowServer(600);
    open.push(server);
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: server.url, models: ['m1'], timeoutMs: 150 });

    // provider 自身计时 abort → 'This operation was aborted'；
    // 若是 transport 掐断会是 'fetch failed / Headers Timeout Error'
    await expect(provider.chat({ messages: [] })).rejects.toThrow(/abort/i);
  });
});

/**
 * 事故回归（2026-10-30）：网关进程 footprint 涨到 30.5G、主线程冻结在原生
 * `Http2Session::SendPendingData → CopyDataIntoOutgoing`。undici 8.x 的
 * `allowH2` 默认 true，只要端点 ALPN 协商到 h2 就进入该路径。
 *
 * 契约：模型调用的 dispatcher 必须关掉 h2，退回 HTTP/1.1。
 */
describe('createTimeoutDispatcher 不吃 undici 的 HTTP/2 默认值', () => {
  it('dispatcher 的 allowH2 为 false', () => {
    const dispatcher = createTimeoutDispatcher(1000);
    // undici 把选项存在 [kOptions]（Symbol），只能经由内部字段断言
    const opts = (dispatcher as unknown as Record<symbol, { allowH2?: boolean }>)[
      Object.getOwnPropertySymbols(dispatcher).find((s) => String(s).includes('options'))!
    ];
    expect(opts?.allowH2).toBe(false);
    void dispatcher.close();
  });
});

