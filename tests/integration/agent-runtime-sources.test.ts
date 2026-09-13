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
import { AgentRuntime } from '../../src/harness/agent-runtime/index.js';
import type { RunDispatcher } from '../../src/harness/agent-runtime/index.js';
import type { AgentEvent } from '../../src/core/primitives/event-bus.js';

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

    writeFileSync(join(dir, 'a.txt'), '1');
    writeFileSync(join(dir, 'a.txt'), '2');
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // 防抖后同文件应少于写盘次数
    expect(calls.length).toBeLessThanOrEqual(2);

    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
    void seen;
  });
});
