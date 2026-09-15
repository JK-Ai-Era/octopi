/**
 * SessionGate abort 路径
 */

import { describe, it, expect } from 'vitest';
import { SessionGate } from '../../src/harness/concurrency/session-gate.js';
import { SessionAwareRunner } from '../../src/harness/runner.js';
import { Agent } from '../../src/harness/agent/agent.js';
import { InMemorySessionStore } from '../../src/integration/storage/memory.js';
import type { ModelProvider } from '../../src/core/interfaces/model-provider.js';
import type { ReliabilityHarness } from '../../src/core/interfaces/reliability.js';

function mockProvider(): ModelProvider {
  return {
    name: 'mock',
    async chat() {
      return { content: 'ok', model: 'mock', finishReason: 'stop' as const };
    },
    async *stream() {
      yield { type: 'done' as const };
    },
    async isAvailable() {
      return true;
    },
    getModelInfo() {
      return null;
    },
  };
}

function mockHarness(): ReliabilityHarness {
  return {
    config: {
      planningRetry: { maxAttempts: 0, steerInstruction: '' },
      emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
      noopThreshold: 3,
      loopDetection: { enabled: false },
    },
  } as unknown as ReliabilityHarness;
}

describe('SessionGate + Runner abort', () => {
  it('排队中 abort：handle 空结束，不抛 failed', async () => {
    const gate = new SessionGate({ maxConcurrent: 1, waitTimeoutMs: 5000 });
    const release = await gate.enter();

    const agent = new Agent({ model: mockProvider(), systemPrompt: '' });
    const runner = new SessionAwareRunner(agent, mockHarness(), new InMemorySessionStore(), {
      sessionGate: gate,
    });

    const ac = new AbortController();
    const events: unknown[] = [];
    const handlePromise = (async () => {
      for await (const e of runner.handle(
        's1',
        { role: 'user', content: 'hi', timestamp: Date.now() },
        { systemPrompt: '', agentId: 'a1', sessionId: 's1' },
        ac.signal,
      )) {
        events.push(e);
      }
    })();

    // 等入队后 abort
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await handlePromise;

    expect(events).toEqual([]);
    release();
  });

  it('enter(signal) 排队 abort 时 reject', async () => {
    const gate = new SessionGate({ maxConcurrent: 1, waitTimeoutMs: 5000 });
    const release = await gate.enter();
    const ac = new AbortController();
    const p = gate.enter(ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/i);
    release();
  });
});
