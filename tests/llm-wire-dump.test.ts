import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  ModelProvider,
} from '@octopi-agent/core/interfaces/model-provider.js';
import {
  createWireDumpSink,
  withWireDump,
  wireUnitPayloads,
} from '@octopi-agent/engine/integration/providers/wire-dump.js';
import {
  compareWireCalls,
  reportWireAging,
  explainWireDivergence,
  listWireDumpSessions,
  loadWireDumpBody,
  readFirstWireDumpRequest,
  readWireDumpIndex,
} from '@octopi-agent/engine/integration/providers/wire-dump-diff.js';
import { OpenAIProvider } from '@octopi-agent/engine/integration/providers/openai.js';
import { AnthropicProvider } from '@octopi-agent/engine/integration/providers/anthropic.js';
import { parseArgs } from '../src/cli/args.js';
import { llmDiffCommand } from '../src/cli/llm-diff.js';

const USAGE = {
  outputTokens: 2,
  inputUncachedTokens: 10,
  inputCachedTokens: 90,
  inputCacheWriteTokens: 0,
  inputReportedTokens: 100,
  cacheAware: true,
};

/** 假装是真 provider：body 由 wireBodyFor 构造，chat/stream 直接返回固定结果 */
class FakeProvider implements ModelProvider {
  readonly name = 'fake';
  readonly defaultModel = 'fake-model';
  readonly models = ['fake-model'];
  /** 记录最后一次真正发送的 body，用于校验落盘与发送一致 */
  lastSentBody: Record<string, unknown> | null = null;

  constructor(private messages: Array<{ role: string; content: string }>) {}

  wireBodyFor(request: LLMRequest, mode: 'chat' | 'stream'): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      messages: this.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (request.tools) body.tools = request.tools;
    return mode === 'stream' ? { ...body, stream: true } : body;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    this.lastSentBody = this.wireBodyFor(request, 'chat');
    return {
      content: 'ok',
      model: this.defaultModel,
      finishReason: 'stop',
      usage: { ...USAGE },
    };
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
    this.lastSentBody = this.wireBodyFor(request, 'stream');
    yield { type: 'content', content: 'ok' };
    yield { type: 'done', finishReason: 'stop', usage: { ...USAGE } };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getModelInfo(): null {
    return null;
  }

  getModelInfos(): [] {
    return [];
  }
}

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'octopi-wiredump-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function sinkFor(sessionId: string, extra: { maxCallsPerSession?: number; maxBodyBytes?: number } = {}) {
  return createWireDumpSink({
    dir: rootDir,
    maxCallsPerSession: extra.maxCallsPerSession,
    maxBodyBytes: extra.maxBodyBytes,
    resolveContext: () => ({ sessionId, agentId: 'default', runId: 'run-1' }),
  });
}

function bodyOf(messages: Array<{ role: string; content: string }>): Record<string, unknown> {
  return { model: 'm', messages };
}

describe('wire dump — 落盘', () => {
  test('chat 调用落盘完整 body 与索引，并回填 usage', async () => {
    const provider = new FakeProvider([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    const sink = sinkFor('sess_1');
    const wrapped = withWireDump(provider, sink);

    await wrapped.chat({ model: 'fake-model', messages: [] });
    await sink.flush();

    const dir = join(rootDir, 'sess_1');
    const calls = readWireDumpIndex(dir);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.request.msgCount).toBe(2);
    expect(call.request.roles).toEqual(['system', 'user']);
    expect(call.request.sessionId).toBe('sess_1');
    expect(call.request.runId).toBe('run-1');
    expect(call.hasBody).toBe(true);
    expect(call.result?.outcome).toBe('ok');
    expect(call.result?.usage?.inputCachedTokens).toBe(90);

    // 落盘 body 与实际发送一致
    const body = loadWireDumpBody(dir, call.request);
    expect(body).toEqual(provider.lastSentBody);
  });

  test('stream 调用记录 ttft 与 done chunk 的 usage', async () => {
    const provider = new FakeProvider([{ role: 'user', content: 'hi' }]);
    const sink = sinkFor('sess_2');
    const wrapped = withWireDump(provider, sink);

    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of wrapped.stream({ model: 'fake-model', messages: [] })) {
      chunks.push(chunk);
    }
    await sink.flush();

    expect(chunks.map((c) => c.type)).toEqual(['content', 'done']);
    const [call] = readWireDumpIndex(join(rootDir, 'sess_2'));
    expect(call.request.mode).toBe('stream');
    expect(call.result?.outcome).toBe('ok');
    expect(call.result?.ttftMs).not.toBeUndefined();
    expect(call.result?.usage?.inputCachedTokens).toBe(90);
  });

  test('每 session 环形上限：只保留最新 N 条 body，索引同步压缩', async () => {
    const sink = sinkFor('sess_3', { maxCallsPerSession: 2 });
    const provider = new FakeProvider([{ role: 'user', content: 'hi' }]);
    const wrapped = withWireDump(provider, sink);

    for (let i = 0; i < 3; i++) {
      await wrapped.chat({ model: 'fake-model', messages: [] });
      await sink.flush();
    }

    const dir = join(rootDir, 'sess_3');
    const bodies = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(bodies).toHaveLength(2);
    const calls = readWireDumpIndex(dir);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.hasBody)).toBe(true);
  });

  test('无 RunScope 时落到 _unscoped 桶', async () => {
    const sink = createWireDumpSink({ dir: rootDir });
    const provider = new FakeProvider([{ role: 'user', content: 'hi' }]);
    await withWireDump(provider, sink).chat({ messages: [] });
    await sink.flush();

    expect(existsSync(join(rootDir, '_unscoped', 'index.jsonl'))).toBe(true);
  });

  test('消费者提前中断 → outcome=abandoned（索引不残留未收尾调用）', async () => {
    const sink = sinkFor('sess_abandon');
    const provider = new FakeProvider([{ role: 'user', content: 'hi' }]);
    const gen = withWireDump(provider, sink).stream({ model: 'fake-model', messages: [] });

    await gen.next();
    await gen.return(undefined);
    await sink.flush();

    const [call] = readWireDumpIndex(join(rootDir, 'sess_abandon'));
    expect(call.result?.outcome).toBe('abandoned');
    expect(call.result?.ttftMs).not.toBeUndefined();
  });

  test('流正常读完但没有 done 哨兵 → outcome=ok，usage 不丢', async () => {
    // 代理/兼容端点可能不发 [DONE]/message_stop：正常结束不能记成"消费者放弃"
    class NoDoneProvider extends FakeProvider {
      async *stream(): AsyncGenerator<LLMStreamChunk> {
        yield { type: 'content', content: 'ok', usage: { ...USAGE } };
      }
    }
    const sink = sinkFor('sess_nodone');
    const wrapped = withWireDump(new NoDoneProvider([{ role: 'user', content: 'hi' }]), sink);

    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of wrapped.stream({ model: 'fake-model', messages: [] })) {
      chunks.push(chunk);
    }
    await sink.flush();

    expect(chunks.map((c) => c.type)).toEqual(['content']);
    const [call] = readWireDumpIndex(join(rootDir, 'sess_nodone'));
    expect(call.result?.outcome).toBe('ok');
    expect(call.result?.usage?.inputCachedTokens).toBe(90);
  });

  test('provider 抛错 → outcome=error，请求仍被记录', async () => {
    class BoomProvider extends FakeProvider {
      async chat(): Promise<LLMResponse> {
        throw new Error('boom');
      }
    }
    const sink = sinkFor('sess_error');
    const wrapped = withWireDump(new BoomProvider([{ role: 'user', content: 'hi' }]), sink);

    await expect(wrapped.chat({ model: 'fake-model', messages: [] })).rejects.toThrow('boom');
    await sink.flush();

    const [call] = readWireDumpIndex(join(rootDir, 'sess_error'));
    expect(call.request.msgCount).toBe(1);
    expect(call.result?.outcome).toBe('error');
  });

  test('wireBodyFor 抛错时请求照常透传（观测 fail-open）', async () => {
    class BadBuilder extends FakeProvider {
      wireBodyFor(): Record<string, unknown> {
        throw new Error('builder boom');
      }
      async chat(): Promise<LLMResponse> {
        // 不经过 wireBodyFor：验证装饰器自身的 fail-open
        return { content: 'ok', model: this.defaultModel, finishReason: 'stop' };
      }
    }
    const sink = sinkFor('sess_failopen');
    const wrapped = withWireDump(new BadBuilder([{ role: 'user', content: 'hi' }]), sink);

    const res = await wrapped.chat({ model: 'fake-model', messages: [] });
    await sink.flush();

    expect(res.content).toBe('ok');
    expect(readWireDumpIndex(join(rootDir, 'sess_failopen'))).toHaveLength(0);
  });
});

describe('wire dump — 与真实 provider 的实际发送体同源', () => {
  /** 拦 fetch，返回失败响应：body 已在抛错前发出，足够比对 */
  function captureFetch(): { bodies: Array<Record<string, unknown>>; restore: () => void } {
    const bodies: Array<Record<string, unknown>> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('boom', { status: 500 });
    }) as typeof fetch;
    return { bodies, restore: () => (globalThis.fetch = original) };
  }

  test('OpenAIProvider chat：实际发出 body 等于 wireBodyFor(chat)', async () => {
    const cap = captureFetch();
    try {
      const provider = new OpenAIProvider({
        name: 'openai',
        apiKey: 'k',
        baseUrl: 'https://example.invalid/v1',
        models: [{ name: 'm', maxOutputTokens: 100 }],
        defaultModel: 'm',
      });
      const request: LLMRequest = {
        messages: [
          { role: 'system', content: 'sys' } as never,
          { role: 'user', content: 'hi' } as never,
        ],
        tools: [
          { type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } },
        ],
        maxTokens: 500,
      };
      await expect(provider.chat(request)).rejects.toThrow();
      expect(cap.bodies).toHaveLength(1);
      expect(cap.bodies[0]).toEqual(provider.wireBodyFor(request, 'chat'));
    } finally {
      cap.restore();
    }
  });

  test('OpenAIProvider stream：stream/stream_options 与实际发送一致', async () => {
    const cap = captureFetch();
    try {
      const provider = new OpenAIProvider({
        name: 'openai',
        apiKey: 'k',
        baseUrl: 'https://example.invalid/v1',
        models: [{ name: 'm', maxOutputTokens: 100 }],
        defaultModel: 'm',
      });
      const request: LLMRequest = { messages: [{ role: 'user', content: 'hi' } as never] };
      await expect(async () => {
        for await (const _chunk of provider.stream(request)) {
          // 500 响应会立刻抛错；body 已捕获
        }
      }).rejects.toThrow();
      expect(cap.bodies).toHaveLength(1);
      expect(cap.bodies[0]).toEqual(provider.wireBodyFor(request, 'stream'));
      expect(cap.bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    } finally {
      cap.restore();
    }
  });

  test('AnthropicProvider chat/stream：system 提升与 stream 开关与实际发送一致', async () => {
    const provider = new AnthropicProvider({
      name: 'anthropic',
      apiKey: 'k',
      baseUrl: 'https://example.invalid',
      models: [{ name: 'claude', maxOutputTokens: 100 }],
      defaultModel: 'claude',
    });
    const request: LLMRequest = {
      messages: [
        { role: 'system', content: 'be brief' } as never,
        { role: 'user', content: 'hi' } as never,
      ],
    };

    for (const mode of ['chat', 'stream'] as const) {
      const cap = captureFetch();
      try {
        if (mode === 'chat') {
          await expect(provider.chat(request)).rejects.toThrow();
        } else {
          await expect(async () => {
            for await (const _chunk of provider.stream(request)) {
              // 500 响应会立刻抛错
            }
          }).rejects.toThrow();
        }
        expect(cap.bodies).toHaveLength(1);
        expect(cap.bodies[0]).toEqual(provider.wireBodyFor(request, mode));
      } finally {
        cap.restore();
      }
    }
  });
});

describe('wire dump — 环形上限的索引一致性', () => {
  test('裁剪后才 finish 的调用不留孤儿 result 行', async () => {
    const sink = sinkFor('sess_late', { maxCallsPerSession: 1 });

    const stale = sink.capture({
      provider: 'p',
      model: 'm',
      mode: 'chat',
      body: bodyOf([{ role: 'user', content: 'first' }]),
    })!;
    sink.capture({
      provider: 'p',
      model: 'm',
      mode: 'chat',
      body: bodyOf([{ role: 'user', content: 'second' }]),
    });
    await sink.flush();

    // 长流式调用：request 行已被逐出，收尾才到达
    stale.finish({ outcome: 'ok', durationMs: 5 });
    await sink.flush();

    const dir = join(rootDir, 'sess_late');
    const calls = readWireDumpIndex(dir);
    expect(calls).toHaveLength(1);
    expect(calls[0].request.id).not.toBe(stale.id);
    expect(calls[0].result).toBeUndefined();
    // 索引原始行数也必须只有 request 那一行
    const lines = readFileSync(join(dir, 'index.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  test('重启后按索引恢复计数：oversize 调用也参与逐出', async () => {
    const oversizeBody = bodyOf([{ role: 'user', content: 'x'.repeat(200) }]);

    const first = sinkFor('sess_restart', { maxCallsPerSession: 1, maxBodyBytes: 16 });
    first.capture({ provider: 'p', model: 'm', mode: 'chat', body: oversizeBody })!.finish({
      outcome: 'ok',
      durationMs: 1,
    });
    await first.flush();

    const dir = join(rootDir, 'sess_restart');
    expect(readWireDumpIndex(dir)[0]!.request.oversize).toBe(true);

    // 模拟进程重启：新 sink 复用同一目录
    const second = sinkFor('sess_restart', { maxCallsPerSession: 1 });
    second.capture({
      provider: 'p',
      model: 'm',
      mode: 'chat',
      body: bodyOf([{ role: 'user', content: 'small' }]),
    })!.finish({ outcome: 'ok', durationMs: 1 });
    await second.flush();

    const calls = readWireDumpIndex(dir);
    expect(calls).toHaveLength(1);
    expect(calls[0].request.oversize).toBe(false);
  });

  test('oversize：body 不落盘但索引保留，hasBody=false', async () => {
    const sink = sinkFor('sess_oversize', { maxBodyBytes: 16 });
    sink.capture({
      provider: 'p',
      model: 'm',
      mode: 'chat',
      body: bodyOf([{ role: 'user', content: 'x'.repeat(200) }]),
    })!.finish({ outcome: 'ok', durationMs: 1 });
    await sink.flush();

    const calls = readWireDumpIndex(join(rootDir, 'sess_oversize'));
    expect(calls).toHaveLength(1);
    expect(calls[0].request.oversize).toBe(true);
    expect(calls[0].request.file).toBeUndefined();
    expect(calls[0].hasBody).toBe(false);
  });
});

describe('wire dump — 索引读取健壮性', () => {
  test('半行 / 乱序 / result 在前：仍能正确合并与排序', () => {
    const dir = join(rootDir, 'sess_broken');
    mkdirSync(dir, { recursive: true });
    const reqA = {
      type: 'request',
      id: '2000-1-1',
      at: 2000,
      n: 1,
      provider: 'p',
      model: 'm',
      mode: 'chat',
      msgCount: 1,
      chars: 1,
      bodyBytes: 1,
      oversize: false,
      toolCount: 0,
      toolsHash: '',
      roles: ['user'],
      lens: [1],
      hashes: ['h1'],
    };
    const reqB = { ...reqA, id: '1000-1-1', at: 1000 };
    const resA = { type: 'result', id: '2000-1-1', at: 2001, outcome: 'ok', durationMs: 3 };
    const lines = [
      JSON.stringify(resA),
      JSON.stringify(reqA),
      '{"type":"request","id":"trunc', // 进程被杀留下的半行
      JSON.stringify(reqB),
    ];
    writeFileSync(join(dir, 'index.jsonl'), `${lines.join('\n')}\n`);

    const calls = readWireDumpIndex(dir);
    expect(calls.map((c) => c.request.id)).toEqual(['1000-1-1', '2000-1-1']);
    expect(calls[0]!.result).toBeUndefined();
    expect(calls[1]!.result?.outcome).toBe('ok');
    // 首行是 result：readFirstWireDumpRequest 仍要找到第一条 request
    expect(readFirstWireDumpRequest(dir)?.id).toBe('2000-1-1');
  });
});

describe('wire dump — 前缀比对', () => {
  async function record(messages: Array<{ role: string; content: string }>) {
    const sink = sinkFor('sess_diff');
    const provider = new FakeProvider(messages);
    await withWireDump(provider, sink).chat({ model: 'fake-model', messages: [] });
    await sink.flush();
    return readWireDumpIndex(join(rootDir, 'sess_diff'));
  }

  test('纯追加判定为 append-only', async () => {
    await record([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    const calls = await record([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'next' },
    ]);

    const diff = compareWireCalls(calls[0]!, calls[1]!);
    expect(diff.stability).toBe('append-only');
    expect(diff.commonPrefix).toBe(2);
    expect(diff.appended).toBe(2);
    expect(diff.divergence).toBeUndefined();
  });

  test('尾部被删判定为 truncated（公共前缀覆盖较短一方）', async () => {
    await record([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    const calls = await record([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);

    const diff = compareWireCalls(calls[0]!, calls[1]!);
    expect(diff.stability).toBe('truncated');
    expect(diff.commonPrefix).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.divergence).toBeUndefined();
  });

  test('历史中部改写判定为 diverged 并给出消息下标', async () => {
    await record([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    const calls = await record([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello CHANGED' },
    ]);

    const diff = compareWireCalls(calls[0]!, calls[1]!);
    expect(diff.stability).toBe('diverged');
    expect(diff.divergence?.index).toBe(2);
    expect(diff.divergence?.prevRole).toBe('assistant');
    expect(diff.stableChars).toBeGreaterThan(0);

    const dir = join(rootDir, 'sess_diff');
    const prevBody = loadWireDumpBody(dir, calls[0]!.request)!;
    const nextBody = loadWireDumpBody(dir, calls[1]!.request)!;
    const detail = explainWireDivergence(prevBody, nextBody, 2)!;
    expect(detail.offset).toBeGreaterThan(0);
    expect(detail.prevSnippet).toContain('hello');
    expect(detail.nextSnippet).toContain('hello<|> CHANGED');
    // 断点标记必须落在首个不同字符处：两者都在 `hello` 之后断开，且标记不是省略号
    expect(detail.prevSnippet).toContain('hello<|>"}');
    expect(detail.nextSnippet).toContain('hello<|> CHANGED');
  });

  test('system prompt 变化在最前一条断链（commonPrefix=0）', async () => {
    await record([
      { role: 'system', content: 'sys A' },
      { role: 'user', content: 'hi' },
    ]);
    const calls = await record([
      { role: 'system', content: 'sys B' },
      { role: 'user', content: 'hi' },
    ]);

    const diff = compareWireCalls(calls[0]!, calls[1]!);
    expect(diff.stability).toBe('diverged');
    expect(diff.commonPrefix).toBe(0);
    expect(diff.stableChars).toBe(0);
    expect(diff.cacheableChars).toBe(0);
  });

  test('tools 变化单独标记，并使 cacheableChars 归零', async () => {
    const sink = sinkFor('sess_tools');
    const provider = new FakeProvider([{ role: 'user', content: 'hi' }]);
    const wrapped = withWireDump(provider, sink);
    const toolsA = [{ type: 'function' as const, function: { name: 'a', description: '', parameters: {} } }];
    const toolsB = [{ type: 'function' as const, function: { name: 'b', description: '', parameters: {} } }];

    await wrapped.chat({ model: 'fake-model', messages: [], tools: toolsA });
    await sink.flush();
    await wrapped.chat({ model: 'fake-model', messages: [], tools: toolsB });
    await sink.flush();

    const calls = readWireDumpIndex(join(rootDir, 'sess_tools'));
    const diff = compareWireCalls(calls[0]!, calls[1]!);
    expect(diff.stability).toBe('identical');
    expect(diff.toolsChanged).toBe(true);
    // 消息前缀一致，但 tools 在请求最前，缓存一条都命中不了
    expect(diff.stableChars).toBeGreaterThan(0);
    expect(diff.cacheableChars).toBe(0);
  });
});

describe('wire dump — 前缀单元顺序', () => {
  test('Anthropic 顶层 system 视为第一条前缀单元', () => {
    const payloads = wireUnitPayloads({
      model: 'claude',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'you are a bot',
    });
    expect(payloads.map((p) => p.role)).toEqual(['system', 'user']);
    expect(payloads[0]!.text).toContain('you are a bot');
  });

  test('session 目录列表按更新时间倒序', async () => {
    const sinkA = sinkFor('a');
    await withWireDump(new FakeProvider([{ role: 'user', content: 'hi' }]), sinkA).chat({ messages: [] });
    await sinkA.flush();
    const sinkB = sinkFor('b');
    await withWireDump(new FakeProvider([{ role: 'user', content: 'hi' }]), sinkB).chat({ messages: [] });
    await sinkB.flush();

    const sessions = listWireDumpSessions(rootDir);
    expect(sessions.map((s) => s.sessionId)).toEqual(['b', 'a']);
  });
});

describe('wire dump — 老化（原文 → 指针）识别', () => {
  const AGED = '[aged tool result · pointer] tool: file_read; args: {"path":"x"}';

  test('单点改写 changedAfter=0；批量老化 changedAfter>0 且能定位首个老化位置', async () => {
    const sink = sinkFor('sess_aging');
    const original = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'tool', content: '{"matches":["a","b"]}' },
      { role: 'tool', content: '{"matches":["c","d"]}' },
      { role: 'assistant', content: 'done' },
    ];
    const aged = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'tool', content: AGED },
      { role: 'tool', content: AGED },
      { role: 'assistant', content: 'done' },
    ];

    for (const messages of [original, aged]) {
      sink.capture({ provider: 'p', model: 'm', mode: 'chat', body: bodyOf(messages) })!
        .finish({ outcome: 'ok', durationMs: 1 });
      await sink.flush();
    }

    const dir = join(rootDir, 'sess_aging');
    const calls = readWireDumpIndex(dir);
    const diff = compareWireCalls(calls[0], calls[1]);
    expect(diff.stability).toBe('diverged');
    expect(diff.divergence?.index).toBe(2);
    expect(diff.changedAfter).toBe(2); // msg[2] 与 msg[3] 都变了，不只首个分歧点

    const aging = reportWireAging(
      loadWireDumpBody(dir, calls[0].request)!,
      loadWireDumpBody(dir, calls[1].request)!,
    )!;
    expect(aging.agedInPlace).toBe(2);
    expect(aging.firstAgedIndex).toBe(2);
    expect(aging.prevPointers).toBe(0);
    expect(aging.nextPointers).toBe(2);
  });

  test('append-only 无老化时不误报', async () => {
    const sink = sinkFor('sess_noaging');
    const base = [
      { role: 'system', content: 'sys' },
      { role: 'tool', content: AGED },
    ];
    for (const messages of [base, [...base, { role: 'user', content: 'more' }]]) {
      sink.capture({ provider: 'p', model: 'm', mode: 'chat', body: bodyOf(messages) })!
        .finish({ outcome: 'ok', durationMs: 1 });
      await sink.flush();
    }

    const calls = readWireDumpIndex(join(rootDir, 'sess_noaging'));
    expect(compareWireCalls(calls[0], calls[1]).changedAfter).toBe(0);
    const aging = reportWireAging(
      loadWireDumpBody(join(rootDir, 'sess_noaging'), calls[0].request)!,
      loadWireDumpBody(join(rootDir, 'sess_noaging'), calls[1].request)!,
    )!;
    expect(aging.agedInPlace).toBe(0);
    expect(aging.nextPointers).toBe(1);
  });
});

describe('llm-diff — CLI 边界', () => {
  test('--limit 接受 0 与正整数，拒绝非法值', () => {
    expect(parseArgs(['llm-diff', '--limit', '0']).limit).toBe(0);
    expect(parseArgs(['llm-diff', '--limit', '12']).limit).toBe(12);
    // 负值会被 llm-diff 当成「全部」，'12abc' 会被 parseInt 截成 12：都不能静默接受
    expect(() => parseArgs(['llm-diff', '--limit', '-5'])).toThrow(/--limit/);
    expect(() => parseArgs(['llm-diff', '--limit', '12abc'])).toThrow(/--limit/);
  });

  test('--session / --dir 缺值时显式报错，不静默回退到最近 session', () => {
    expect(() => parseArgs(['llm-diff', '--session'])).toThrow(/--session/);
    expect(() => parseArgs(['llm-diff', '--session', '--json'])).toThrow(/--session/);
    expect(() => parseArgs(['llm-diff', '--dir'])).toThrow(/--dir/);
    expect(parseArgs(['llm-diff', '--session', 'abc']).session).toBe('abc');
  });

  test('session 片段多命中时报歧义并列候选，而不是随便挑一个', async () => {
    for (const id of ['sess-aaa', 'sess-bbb']) {
      const sink = createWireDumpSink({
        dir: rootDir,
        resolveContext: () => ({ sessionId: id }),
      });
      sink.capture({
        provider: 'p',
        model: 'm',
        mode: 'chat',
        body: bodyOf([{ role: 'user', content: 'hi' }]),
      })!.finish({ outcome: 'ok', durationMs: 1 });
      await sink.flush();
    }

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
    await llmDiffCommand({ command: 'llm-diff', dir: rootDir, session: 'sess-' } as never);

    expect(logs.join('\n')).toContain('ambiguous');
    expect(logs.join('\n')).toContain('sess-aaa');
    expect(logs.join('\n')).toContain('sess-bbb');
  });

  test('默认挑选对话 session，跳过 sessionId==agentId 的子系统桶', async () => {
    // 子系统桶（摘要/任务快照）更晚写入，若按 mtime 直选会误命中它
    const conv = createWireDumpSink({
      dir: rootDir,
      resolveContext: () => ({ sessionId: 'web-sess-1', agentId: 'default' }),
    });
    conv.capture({ provider: 'p', model: 'm', mode: 'chat', body: bodyOf([{ role: 'user', content: 'x' }]) })!
      .finish({ outcome: 'ok', durationMs: 1 });
    await conv.flush();

    const subsystem = createWireDumpSink({
      dir: rootDir,
      resolveContext: () => ({ sessionId: 'default', agentId: 'default' }),
    });
    subsystem.capture({ provider: 'p', model: 'm', mode: 'chat', body: bodyOf([{ role: 'user', content: 'y' }]) })!
      .finish({ outcome: 'ok', durationMs: 1 });
    await subsystem.flush();

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
    await llmDiffCommand({ command: 'llm-diff', dir: rootDir } as never);

    expect(logs.join('\n')).toContain('session=web-sess-1');
    expect(logs.join('\n')).not.toContain('session=default  ');
  });

  test('--limit 只影响展示，前缀比对仍基于真实相邻调用', async () => {
    const sink = sinkFor('sess_limit');
    for (const content of ['a', 'b']) {
      sink.capture({
        provider: 'p',
        model: 'm',
        mode: 'chat',
        body: bodyOf([{ role: 'user', content }]),
      })!.finish({ outcome: 'ok', durationMs: 1 });
      await sink.flush();
    }

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
    await llmDiffCommand({ command: 'llm-diff', dir: rootDir, session: 'sess_limit', limit: 1 } as never);

    // 仅展示最后 1 条 → 没有可比的相邻对
    expect(logs.join('\n')).toContain('need at least two calls');
  });
});
