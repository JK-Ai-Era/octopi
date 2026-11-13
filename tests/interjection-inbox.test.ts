/**
 * 活跃插话跨进程注入（arch/service-topology-p2.md §2.1-1 清偿，2026-11-14）。
 *
 * 测试纪律（T4b 评审方法论教训）：真实 Gateway + 真实 run 子进程 + 假 LLM——
 * 只 mock 外部服务（LLM HTTP），禁自造 gateway/hook seam。假 LLM 可按脚本
 * 暂停响应（hold-tool-call / hold-final），用真实 task_list 工具与纯文本收尾
 * 两条路径确定性制造「run 进行中插话」与「终答生成期插话」时序。
 *
 * 判据（MAJ-1/MAJ-2 回归锚在 ①' ②'）：
 * ① 工具调用间隙插话：注入**下一次 LLM 调用位**（同 run 多 turn，不开新 run），
 *    晚到回复经渠道恰好发一次（replyToId=插话消息）；
 * ①' 终答生成期插话（MAJ-1）：不把旧答错发给插话；inbox 排队重投后补达真实回答；
 * ②' lease_held 重投（MAJ-2）：拒可见（[Gateway Error]+重试标记）+ 晚到补答恰好一次；
 * ③ dispatch 失败可见：合成终态事件进流式面（此前 ws 无 adapter + 无 run 事件 = 静默丢）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import { defaultHitlCache } from '@octopi-agent/engine/harness/governance/human-in-the-loop/decision-cache.js';
import type {
  ChannelAdapter,
  ChannelReply,
  ChannelMessage,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/channel-types.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';

// ── 假 LLM 外部服务（只 mock 外部服务）：按脚本逐步响应，可暂停 ──

type FakeStep =
  | { kind: 'hold-tool-call' } // 暂停响应，直到 releaseHeld()；然后回 tool_calls（task_list）
  | { kind: 'hold-final'; content: string } // 暂停响应，直到 releaseHeld()；然后回纯文本终答
  | { kind: 'final'; content: string } // 最终回答（回显 content）
  | { kind: 'http-error'; status: number }; // LLM 服务错误（run 失败）

const state: {
  script: FakeStep[];
  bodies: string[];
  heldRelease: (() => void) | null;
  arrivalResolve: ((n: number) => void) | null;
} = {
  script: [],
  bodies: [],
  heldRelease: null,
  arrivalResolve: null,
};

let llmServer: Server;
let llmUrl: string;

function isStream(body: string): boolean {
  return body.includes('"stream":true') || body.includes('"stream": true');
}

function respondFinal(res: ServerResponse, body: string, content: string): void {
  if (isStream(body)) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'c',
      object: 'chat.completion',
      created: 0,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

function respondToolCall(res: ServerResponse, body: string): void {
  const toolCall = {
    index: 0,
    id: 'tc1',
    type: 'function',
    function: { name: 'task_list', arguments: '{}' },
  };
  if (isStream(body)) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [toolCall] }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'c',
      object: 'chat.completion',
      created: 0,
      model: 'm',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'task_list', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

/** 设置本测试的响应脚本（末位步骤对后续请求重复生效），返回「首个请求已到」的 promise */
function setScript(script: FakeStep[]): Promise<number> {
  state.script = script;
  state.bodies = [];
  state.heldRelease = null;
  return new Promise<number>((resolve) => {
    state.arrivalResolve = resolve;
  });
}

function releaseHeld(): void {
  state.heldRelease?.();
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  llmServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
    });
    req.on('end', () => {
      state.bodies.push(body);
      state.arrivalResolve?.(state.bodies.length);
      state.arrivalResolve = null;
      const step = state.script[Math.min(state.bodies.length - 1, state.script.length - 1)] ?? {
        kind: 'http-error' as const,
        status: 500,
      };
      if (step.kind === 'hold-tool-call') {
        state.heldRelease = () => respondToolCall(res, body);
        return;
      }
      if (step.kind === 'hold-final') {
        state.heldRelease = () => respondFinal(res, body, step.content);
        return;
      }
      if (step.kind === 'http-error') {
        res.writeHead(step.status, { 'content-type': 'text/plain' });
        res.end('fake llm error');
        return;
      }
      respondFinal(res, body, step.content);
    });
  });
  await new Promise<void>((resolve) => llmServer.listen(0, '127.0.0.1', resolve));
  const addr = llmServer.address();
  if (addr === null || typeof addr === 'string') throw new Error('fake llm bind failed');
  llmUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => llmServer?.close(() => resolve()));
});

// ── 测试渠道（带流式广播捕获——③ 的断言面） ──

class TestChannel implements ChannelAdapter {
  readonly sent: ChannelReply[] = [];
  readonly broadcasts: Array<{ sessionId: string; event: AgentEvent }> = [];
  constructor(readonly name: string) {}
  async start(): Promise<void> {}
  async send(reply: ChannelReply): Promise<void> {
    this.sent.push(reply);
  }
  broadcastEvent(sessionId: string, event: AgentEvent): void {
    this.broadcasts.push({ sessionId, event });
  }
  async stop(): Promise<void> {}
}

function msg(content: string, id: string, metadata?: Record<string, unknown>): ChannelMessage {
  return {
    id,
    channel: 'chan-a',
    senderId: 'u1',
    content,
    conversationId: 'c1',
    timestamp: Date.now(),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

describe('活跃插话跨进程注入（§2.1-1）', () => {
  let root: string;
  let previousHome: string | undefined;
  let gateway: Gateway;
  let chan: TestChannel;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'interjection-'));
    previousHome = process.env.OCTOPI_HOME;
    process.env.OCTOPI_HOME = join(root, 'home');
    defaultHitlCache.clear();
    mkdirSync(join(root, 'home', 'sessions'), { recursive: true });
    const store = new JsonlSessionStore({ sessionsDir: join(root, 'home', 'sessions') });
    chan = new TestChannel('chan-a');
    gateway = new Gateway(
      {
        agents: [
          {
            id: 'host-agent',
            home: join(root, 'host-agent'),
            workspace: join(root, 'host-ws'),
            persona: { name: 'host-agent', description: '', systemPrompt: 'HOST_SYS' },
            model: { provider: 'mock', model: 'm' },
            tools: { allow: ['task_list'] },
          },
        ],
        knowledge: { service: { manageLocal: false } },
        modelProviders: {
          mock: {
            api: 'openai-completions',
            baseUrl: llmUrl,
            apiKey: 'test',
            models: [{ id: 'm', name: 'm', contextWindow: 32000, maxTokens: 4096 }],
          },
        },
      },
      store,
    );
    gateway.registerChannel(chan);
    await gateway.start();
  });

  afterEach(async () => {
    await gateway.stop();
    if (previousHome === undefined) delete process.env.OCTOPI_HOME;
    else process.env.OCTOPI_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('判据主锚：run 进行中 human 插话注入下一次 LLM 调用位，晚到回复恰好一次，不开第二个 run', async () => {
    const first = setScript([{ kind: 'hold-tool-call' }, { kind: 'final', content: 'ANSWER_MARK' }]);

    const sendA = gateway.send(msg('MSG_A_MARK', 'ma'));
    await first; // LLM 调用 1 已到：run 活跃、lease 在手
    // 插话：活跃 run 经 inbox 接收（continued）→ 本调用即时返回，不等 run 结束
    await gateway.send(msg('INTERJECT_MARK', 'mb'));
    releaseHeld();
    await sendA;
    // 等待窗口 > 重投延迟（2s）：若插话没进 inbox 而是撞 lease 闸重投，此处会多出第 3 次调用
    await new Promise((r) => setTimeout(r, 2500));

    expect(state.bodies).toHaveLength(2); // 单 run 两次 LLM 调用（B 未开新 run）
    expect(state.bodies[0]).toContain('MSG_A_MARK');
    expect(state.bodies[1]).toContain('task_list'); // 真实工具结果：钉出第二次调用
    // 判据主锚：插话注入**下一次 LLM 调用位**（大哥设计原则：插到下一次 llm 调用的位置）
    expect(state.bodies[1]).toContain('INTERJECT_MARK');

    const replies = chan.sent;
    // 主回复（to ma）与晚到回复（to mb）各恰好一次
    expect(replies.filter((r) => r.replyToId === 'ma').map((r) => r.content)).toEqual(['ANSWER_MARK']);
    expect(replies.filter((r) => r.replyToId === 'mb').map((r) => r.content)).toEqual(['ANSWER_MARK']);
  }, 30_000);

  it("判据①'（MAJ-1 回归锚）：终答生成期插话不误捕旧答——重投补达真实回答", async () => {
    void setScript([
      { kind: 'hold-final', content: 'ANSWER_OLD' },
      { kind: 'final', content: 'ANSWER_FOR_INTERJECT' },
    ]);

    const sendA = gateway.send(msg('MSG_A', 'ma'));
    await waitFor(() => state.bodies.length >= 1, 10_000);
    // 终答生成期插话：offer 被受理（continued）但 run 尾分支不消费——inbox 排队，
    // run 关闭后按原 Trigger 重投新 run 回答（MAJ-1 事故形态：旧答被错发给插话）
    await gateway.send(msg('INTERJECT_MARK', 'mb'));
    releaseHeld();
    await sendA;

    // 旧答（纯文本收尾）只回 ma，绝不作为插话回答发出
    expect(chan.sent.filter((r) => r.replyToId === 'ma').map((r) => r.content)).toEqual(['ANSWER_OLD']);
    // 重投的新 run 真正回答插话，恰好一次
    await waitFor(
      () => chan.sent.some((r) => r.replyToId === 'mb' && r.content === 'ANSWER_FOR_INTERJECT'),
      15_000,
    );
    expect(chan.sent.filter((r) => r.replyToId === 'mb').map((r) => r.content)).toEqual([
      'ANSWER_FOR_INTERJECT',
    ]);
  }, 30_000);

  it("判据②'（MAJ-2 回归锚）：lease_held 重投——拒可见 + 晚到补答恰好一次", async () => {
    void setScript([
      { kind: 'hold-tool-call' },
      { kind: 'final', content: 'ANSWER_OLD' },
      { kind: 'final', content: 'ANSWER_FOR_B' },
    ]);

    const sendA = gateway.send(msg('MSG_A', 'ma'));
    await waitFor(() => state.bodies.length >= 1, 10_000);
    // B 带消息级 model 覆盖 → inbox modelSwitch 判定不接续 → 照常开新 run → 撞
    // run lease 闸（A 活跃）→ 'failed'+retryScheduled：拒可见，2s 后重投补达
    await gateway.send(msg('INTERJECT_B', 'mb', { model: 'mock/m' }));
    releaseHeld();
    await sendA;

    // 拒可见：[Gateway Error] 带重试标记（原样回到用户可见面）
    const errReplies = chan.sent.filter((r) => r.replyToId === 'mb' && r.content.includes('[Gateway Error]'));
    expect(errReplies).toHaveLength(1);
    expect(errReplies[0]!.content).toContain('已自动重试');
    // 重投补答恰好一次（晚到通道），且不是错捕旧答
    await waitFor(
      () => chan.sent.some((r) => r.replyToId === 'mb' && r.content === 'ANSWER_FOR_B'),
      15_000,
    );
    const mbAnswers = chan.sent
      .filter((r) => r.replyToId === 'mb' && !r.content.includes('[Gateway Error]'))
      .map((r) => r.content);
    expect(mbAnswers).toEqual(['ANSWER_FOR_B']);
  }, 30_000);

  it('判据③：dispatch 失败可见——合成终态事件进流式面 + 渠道回执（不静默丢）', async () => {
    void setScript([{ kind: 'http-error', status: 400 }]);

    await gateway.send(msg('hi', 'm1'));

    // IM 渠道回执（既有路径）
    const errReplies = chan.sent.filter((r) => r.content.includes('[Gateway Error]'));
    expect(errReplies.length).toBeGreaterThan(0);
    // 流式面（WS/WebUI 渲染面）合成终态可见（修复③：此前错误路径无 run 事件 = 静默）
    expect(
      chan.broadcasts.some(
        (b) => b.event.type === 'step.end' && JSON.stringify((b.event as { data?: unknown }).data ?? {}).includes('[Gateway Error]'),
      ),
    ).toBe(true);
  }, 30_000);
});
