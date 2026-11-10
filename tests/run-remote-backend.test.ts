/**
 * 协议级 e2e：RemoteRunBackend ↔ run-serve-child（真实 fork 子进程 + loopback HTTP）。
 *
 * 只 mock 外部服务（LLM API 以本地假服务替代）；其余全真实：
 * dist 子进程、boot 交接、RunAssembly 装配、NDJSON 事件流、控制 op、优雅关闭。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import {
  RemoteRunBackend,
  writeRunServeBoot,
} from '@octopi-agent/gateway/gateway/remote-run-backend.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';

const FAKE_REPLY = 'pong from fake llm';

let llmServer: Server;
let llmUrl: string;
let octopiHome: string;
let backend: RemoteRunBackend;

describe('RemoteRunBackend ↔ run-serve-child（协议 e2e）', () => {
  beforeAll(async () => {
    // 假 LLM 外部服务（OpenAI chat completions 形状；按请求 stream 标志回 SSE 或整包 JSON）
    llmServer = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString('utf8');
      });
      req.on('end', () => {
        // m7 锚：SLOW_MARKER 请求挂 5s 不回——客户端断开须触发 run 中止，
        // 而非空转到自然结束（判别窗口 3s < 5s）
        setTimeout(
          () => {
        const wantsStream = body.includes('"stream":true') || body.includes('"stream": true');
        if (wantsStream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'test-model',
              choices: [{ index: 0, delta: { role: 'assistant', content: FAKE_REPLY }, finish_reason: null }],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'test-model',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 0,
            model: 'test-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: FAKE_REPLY },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
          },
          body.includes('SLOW_MARKER') ? 5_000 : 0,
        );
      });
    });
    await new Promise<void>((resolve) => llmServer.listen(0, '127.0.0.1', resolve));
    const addr = llmServer.address();
    if (addr === null || typeof addr === 'string') throw new Error('fake llm bind failed');
    llmUrl = `http://127.0.0.1:${addr.port}`;

    octopiHome = mkdtempSync(join(tmpdir(), 'run-serve-e2e-'));
    mkdirSync(join(octopiHome, 'sessions'), { recursive: true });
    mkdirSync(join(octopiHome, 'workspace'), { recursive: true });
    mkdirSync(join(octopiHome, 'agent-home'), { recursive: true });

    backend = await RemoteRunBackend.start({
      octopiHome,
      config: {
        agents: [],
        modelProviders: {
          fake: {
            api: 'openai-completions',
            baseUrl: llmUrl,
            apiKey: 'test-key',
            models: [{ id: 'test-model', name: 'test-model', contextWindow: 8192, maxTokens: 1024 }],
          },
        },
      },
      agentDefinitions: [
        {
          id: 'test-agent',
          model: { provider: 'fake', model: 'test-model' },
          persona: 'You are a test agent. Answer briefly.',
          workspace: join(octopiHome, 'workspace'),
          home: join(octopiHome, 'agent-home'),
        },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await backend?.stop();
    await new Promise<void>((resolve) => llmServer?.close(() => resolve()));
    rmSync(octopiHome, { recursive: true, force: true });
  });

  it('health 握手（boot + 计数口径）', async () => {
    const health = await backend.health();
    expect(health.mountedAgents).toBe(0);
    expect(health.inFlightRuns).toBe(0);
    expect(health.retiredRunners).toBe(0);
  });

  it('startRun：真实子进程装配 + NDJSON 事件流 + 假 LLM 回复', async () => {
    const events: AgentEvent[] = [];
    for await (const event of backend.startRun({
      requestId: 'r-e2e-1',
      sessionId: 's-e2e-1',
      agentId: 'test-agent',
      triggers: [
        {
          id: 't-e2e-1',
          type: 'message',
          agentId: 'test-agent',
          sessionId: 's-e2e-1',
          payload: { kind: 'user_message', content: 'ping' },
        },
      ],
      messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
    })) {
      events.push(event);
    }
    // 流完整走完（done 终态，无 error entry）；事件经真实装配与假 LLM 产生
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).toContain(FAKE_REPLY);
  }, 60_000);

  it('startRun 未装载 agent：同步错误面（fail-loud，不静默空转）', async () => {
    const iter = backend.startRun({
      requestId: 'r-e2e-2',
      sessionId: 's-e2e-2',
      agentId: 'no-such-agent',
      triggers: [
        {
          id: 't-e2e-2',
          type: 'message',
          agentId: 'no-such-agent',
          sessionId: 's-e2e-2',
          payload: { kind: 'user_message', content: 'ping' },
        },
      ],
      messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
    });
    await expect(async () => {
      for await (const _event of iter) {
        void _event;
      }
    }).rejects.toThrow(/not found/);
  });

  it('control：syncKnowledgeState 幂等 + 未知审批配对 fail-loud', async () => {
    const synced = await backend.control({ type: 'syncKnowledgeState', state: 'ready' });
    expect(synced.ok).toBe(true);
    const late = await backend.control({
      type: 'approvalReply',
      approvalId: 'ap-no-such',
      result: { decision: 'approve' },
    });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.message).toMatch(/unknown approvalId/);
  });

  it('m6：boot 文件 0600 创建（同机多用户不可读）', () => {
    const p = join(tmpdir(), `boot-mode-${randomUUID()}.json`);
    writeRunServeBoot(p, '{"secret":true}');
    try {
      expect(statSync(p).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it('m7：客户端断开 → run 被中止（不空转到 LLM 自然结束）', async () => {
    // 假 LLM 遇 SLOW_MARKER 挂 5s；断连后 run 须在 3s 内中止（in-flight 归零）。
    // 若 m7 缺失（close 不 abort），run 会继续迭代到 5s 自然结束 → 超时失败。
    const iter = backend.startRun({
      requestId: 'r-e2e-m7',
      sessionId: 's-e2e-m7',
      agentId: 'test-agent',
      triggers: [
        {
          id: 't-e2e-m7',
          type: 'message',
          agentId: 'test-agent',
          sessionId: 's-e2e-m7',
          payload: { kind: 'user_message', content: 'SLOW_MARKER ping' },
        },
      ],
      messages: [{ role: 'user', content: 'SLOW_MARKER ping', timestamp: Date.now() }],
    });
    for await (const event of iter) {
      void event;
      break; // 首事件即消费端断开（连接关闭 → 服务端 abort run）
    }
    const deadline = Date.now() + 3000;
    for (;;) {
      const health = await backend.health();
      if (health.inFlightRuns === 0) break;
      if (Date.now() > deadline) {
        throw new Error(`run not aborted after client disconnect (inFlight=${health.inFlightRuns})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 15_000);

  it('m6/m8：boot 读毕即删 + IPC 断连子进程自收摊（孤儿防护）', async () => {
    const before = new Set(
      readdirSync(tmpdir()).filter((f) => f.startsWith('run-serve-boot-')),
    );
    const soloHome = mkdtempSync(join(tmpdir(), 'run-serve-solo-'));
    mkdirSync(join(soloHome, 'sessions'), { recursive: true });
    mkdirSync(join(soloHome, 'workspace'), { recursive: true });
    mkdirSync(join(soloHome, 'agent-home'), { recursive: true });
    const solo = await RemoteRunBackend.start({
      octopiHome: soloHome,
      config: {
        agents: [],
        modelProviders: {
          fake: {
            api: 'openai-completions',
            baseUrl: llmUrl,
            apiKey: 'test-key',
            models: [{ id: 'test-model', name: 'test-model', contextWindow: 8192, maxTokens: 1024 }],
          },
        },
      },
      agentDefinitions: [],
    });
    // m6：boot 在 ready 握手前已删（暴露窗口=启动一瞬）——本次 spawn 无残留。
    // 并行测试文件也在 tmpdir 留 boot：按内容锚定本次 spawn 的 octopiHome，只查自己的文件
    const leaked = readdirSync(tmpdir())
      .filter((f) => f.startsWith('run-serve-boot-') && !before.has(f))
      .filter((f) => readFileSync(join(tmpdir(), f), 'utf8').includes(soloHome));
    expect(leaked).toEqual([]);

    // m8：gateway 侧消失（IPC 断连）→ 子进程自收摊退出，不孤儿、不硬等 stop 兜底
    const child = (solo as unknown as { child: ChildProcess }).child;
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    child.disconnect();
    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ]);
    expect(code).not.toBe('timeout');
    expect(code).toBe(0); // 优雅收摊（disposeAll + dispose schedules + server.close）
    rmSync(soloHome, { recursive: true, force: true });
  }, 30_000);
});
