/**
 * Integration WebhookSource / FileWatchSource
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WebhookSource,
  FileWatchSource,
} from '../../src/integration/index.js';
import { AgentRuntime } from '@octopi-agent/engine/harness/activation/index.js';
import type { RunDispatcher } from '@octopi-agent/engine/harness/activation/index.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';

function mockDispatcher(calls: unknown[]): RunDispatcher {
  return {
    async *execute(req) {
      calls.push(req);
      yield { type: 'engine.end', timestamp: Date.now() } as AgentEvent;
    },
  };
}

afterEach(() => {
  // 防句柄泄漏
});

describe('WebhookSource', () => {
  it('POST 触发 dispatch；超大 body 413', async () => {
    const calls: unknown[] = [];
    const runtime = new AgentRuntime();
    runtime.registerAgent({ agentId: 'a1', dispatcher: mockDispatcher(calls) });
    const source = new WebhookSource({
      port: 0,
      host: '127.0.0.1',
      defaultAgentId: 'a1',
      runtime,
      maxBodyBytes: 256,
    });
    runtime.addSource(source);
    await runtime.start();
    const port = source.port;
    expect(port).toBeGreaterThan(0);

    const ok = await fetch(`http://127.0.0.1:${port}/runtime/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello webhook' }),
    });
    expect(ok.status).toBe(202);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const big = 'x'.repeat(1024);
    const tooBig = await fetch(`http://127.0.0.1:${port}/runtime/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: big }),
    });
    expect(tooBig.status).toBe(413);

    await runtime.stop();
  });
});

describe('FileWatchSource', () => {
  it('目录变更防抖后 emit Trigger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-fw-'));
    const calls: unknown[] = [];
    const runtime = new AgentRuntime();
    runtime.registerAgent({ agentId: 'a1', dispatcher: mockDispatcher(calls) });
    const seen: string[] = [];
    const source = new FileWatchSource({
      dir,
      agentId: 'a1',
      extensions: ['.txt'],
      debounceMs: 50,
    });
    // 通过 runtime.addSource + start 观察 dispatch
    runtime.addSource(source);
    await runtime.start();
    // fs.watch 流启动是异步的（start 返回≠已装订）：留装订窗口，防首事件在监听就绪前丢失
    await new Promise((r) => setTimeout(r, 100));

    writeFileSync(join(dir, 'a.txt'), '1');
    writeFileSync(join(dir, 'a.txt'), '2');
    // 事件送达延迟随平台/负载波动：轮询等防抖触发，固定短睡眠不得当硬上限
    const deadline = Date.now() + 5_000;
    while (calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // 防抖静默窗后再验合并效果：同文件写盘 2 次，dispatch 不得超过写盘次数
    await new Promise((r) => setTimeout(r, 250));
    expect(calls.length).toBeLessThanOrEqual(2);

    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
    void seen;
  });
});
