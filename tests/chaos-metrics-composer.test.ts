/**
 * ChaosProvider + MetricsAggregator + ScenarioComposer 测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChaosProvider } from '../src/testing/chaos-provider.js';
import { MetricsAggregator, formatMetricsSnapshot } from '../src/observability/metrics.js';
import { compose, extendScenario, BuiltinScenarios, runParameterized } from '../src/testing/scenario-composer.js';
import type { TraceEvent } from '../src/observability/trace-events.js';
import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk } from '../src/core/interfaces/model-provider.js';

// ── Mock Provider ──

class SimpleMockProvider implements ModelProvider {
  readonly name = 'mock';
  private response: LLMResponse;

  constructor(response?: LLMResponse) {
    this.response = response ?? { content: 'OK', model: 'm', finishReason: 'stop' };
  }

  async chat(request: LLMRequest): Promise<LLMResponse> { return this.response; }
  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
    if (this.response.content) {
      yield { type: 'content', content: this.response.content };
    }
    yield { type: 'done', usage: this.response.usage };
  }
  async isAvailable(): Promise<boolean> { return true; }
}

// ═══════════════════════════════════════════════════
// ChaosProvider
// ═══════════════════════════════════════════════════

describe('ChaosProvider', () => {

  it('should pass through when no rules match', async () => {
    const mock = new SimpleMockProvider({ content: 'Hello', model: 'm', finishReason: 'stop' });
    const chaos = new ChaosProvider(mock, { rules: [] });

    const resp = await chaos.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'm',
    });

    expect(resp.content).toBe('Hello');
    expect(chaos.getInjectionCount()).toBe(0);
  });

  it('should inject empty response with probability=1', async () => {
    const mock = new SimpleMockProvider({ content: 'Hello', model: 'm', finishReason: 'stop' });
    const chaos = new ChaosProvider(mock, {
      rules: [{ type: 'empty-response', probability: 1 }],
    });

    const resp = await chaos.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'm',
    });

    expect(resp.content).toBe('');
    expect(chaos.getInjectionCount()).toBe(1);
  });

  it('should inject empty response after N calls', async () => {
    const mock = new SimpleMockProvider({ content: 'Hello', model: 'm', finishReason: 'stop' });
    const chaos = new ChaosProvider(mock, {
      rules: [{ type: 'empty-response', after: 2 }],
    });

    // 前两次正常
    const r1 = await chaos.chat({ messages: [{ role: 'user', content: 'A' }], model: 'm' });
    const r2 = await chaos.chat({ messages: [{ role: 'user', content: 'B' }], model: 'm' });
    expect(r1.content).toBe('Hello');
    expect(r2.content).toBe('Hello');

    // 第三次开始注入
    const r3 = await chaos.chat({ messages: [{ role: 'user', content: 'C' }], model: 'm' });
    expect(r3.content).toBe('');
    expect(chaos.getInjectionCount()).toBe(1);
  });

  it('should inject rate limit error', async () => {
    const mock = new SimpleMockProvider({ content: 'Hello', model: 'm', finishReason: 'stop' });
    const chaos = new ChaosProvider(mock, {
      rules: [{ type: 'rate-limit', after: 1, retryAfterMs: 5000 }],
    });

    await chaos.chat({ messages: [{ role: 'user', content: 'A' }], model: 'm' }); // 正常

    try {
      await chaos.chat({ messages: [{ role: 'user', content: 'B' }], model: 'm' });
      expect.fail('Should have thrown');
    } catch (e) {
      expect((e as any).status).toBe(429);
      expect((e as any).retryAfterMs).toBe(5000);
    }
  });

  it('should inject error with custom message', async () => {
    const mock = new SimpleMockProvider({ content: 'Hello', model: 'm', finishReason: 'stop' });
    const chaos = new ChaosProvider(mock, {
      rules: [{ type: 'error', probability: 1, message: 'Test error', status: 500 }],
    });

    try {
      await chaos.chat({ messages: [{ role: 'user', content: 'A' }], model: 'm' });
      expect.fail('Should have thrown');
    } catch (e) {
      expect((e as Error).message).toBe('Test error');
      expect((e as any).status).toBe(500);
    }
  });

  it('should inject malformed response', async () => {
    const mock = new SimpleMockProvider({ content: 'Hello', model: 'm', finishReason: 'stop' });
    const chaos = new ChaosProvider(mock, {
      rules: [{ type: 'malformed', variant: 'missing-content', probability: 1 }],
    });

    const resp = await chaos.chat({
      messages: [{ role: 'user', content: 'A' }],
      model: 'm',
    });

    expect(resp.content).toBeUndefined();
  });

  it('should inject stream faults', async () => {
    const mock = new SimpleMockProvider({ content: 'Hello', model: 'm', finishReason: 'stop' });
    const chaos = new ChaosProvider(mock, {
      rules: [{ type: 'empty-response', probability: 1 }],
    });

    let content = '';
    for await (const chunk of chaos.stream({
      messages: [{ role: 'user', content: 'A' }],
      model: 'm',
    })) {
      if (chunk.type === 'content') content += chunk.content;
    }

    expect(content).toBe('');
    expect(chaos.getInjectionCount()).toBe(1);
  });

  it('should reset call count', async () => {
    const mock = new SimpleMockProvider({ content: 'Hello', model: 'm', finishReason: 'stop' });
    const chaos = new ChaosProvider(mock, {
      rules: [{ type: 'empty-response', after: 1 }],
    });

    await chaos.chat({ messages: [{ role: 'user', content: 'A' }], model: 'm' }); // #0 正常
    await chaos.chat({ messages: [{ role: 'user', content: 'B' }], model: 'm' }); // #1 注入

    chaos.reset();

    const r = await chaos.chat({ messages: [{ role: 'user', content: 'C' }], model: 'm' }); // #0 再次
    expect(r.content).toBe('Hello'); // 应该正常
  });

  it('should log injection history', async () => {
    const mock = new SimpleMockProvider({ content: 'Hello', model: 'm', finishReason: 'stop' });
    const chaos = new ChaosProvider(mock, {
      rules: [{ type: 'error', probability: 1, message: 'err' }],
      logInjections: true,
    });

    try { await chaos.chat({ messages: [{ role: 'user', content: 'A' }], model: 'm' }); } catch {}
    try { await chaos.chat({ messages: [{ role: 'user', content: 'B' }], model: 'm' }); } catch {}

    const log = chaos.getInjectionLog();
    expect(log.length).toBe(2);
    expect(log[0].rule).toBe('error');
    expect(log[1].callIndex).toBe(1);
  });
});

// ═══════════════════════════════════════════════════
// MetricsAggregator
// ═══════════════════════════════════════════════════

describe('MetricsAggregator', () => {

  it('should track LLM calls and tokens', () => {
    const metrics = new MetricsAggregator();

    metrics.processEvent({ ts: Date.now(), level: 3, type: 'model.call.start' });
    metrics.processEvent({
      ts: Date.now(), level: 3, type: 'model.call.end',
      data: { usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, durationMs: 500 },
    });

    const snap = metrics.snapshot();
    expect(snap.llmCalls).toBe(1);
    expect(snap.llmTokensInput).toBe(100);
    expect(snap.llmTokensOutput).toBe(50);
    expect(snap.llmTokensTotal).toBe(150);
    expect(snap.llmLatency.count).toBe(1);
    expect(snap.llmLatency.avg).toBe(500);
  });

  it('should track LLM errors', () => {
    const metrics = new MetricsAggregator();

    metrics.processEvent({ ts: Date.now(), level: 3, type: 'model.call.start' });
    metrics.processEvent({ ts: Date.now(), level: 1, type: 'model.call.error', data: { error: 'timeout' } });

    const snap = metrics.snapshot();
    expect(snap.llmErrors).toBe(1);
  });

  it('should track tool calls by name', () => {
    const metrics = new MetricsAggregator();

    metrics.processEvent({ ts: Date.now(), level: 3, type: 'tool.exec.start', data: { toolName: 'file_write' } });
    metrics.processEvent({ ts: Date.now(), level: 3, type: 'tool.exec.end', data: { toolName: 'file_write', durationMs: 120 } });
    metrics.processEvent({ ts: Date.now(), level: 3, type: 'tool.exec.start', data: { toolName: 'file_read' } });
    metrics.processEvent({ ts: Date.now(), level: 3, type: 'tool.exec.end', data: { toolName: 'file_read', durationMs: 50 } });

    const snap = metrics.snapshot();
    expect(snap.toolCalls['file_write']).toBe(1);
    expect(snap.toolCalls['file_read']).toBe(1);
    expect(snap.toolLatency['file_write'].avg).toBe(120);
    expect(snap.toolLatency['file_read'].avg).toBe(50);
  });

  it('should track tool errors', () => {
    const metrics = new MetricsAggregator();

    metrics.processEvent({ ts: Date.now(), level: 3, type: 'tool.exec.start', data: { toolName: 'shell' } });
    metrics.processEvent({ ts: Date.now(), level: 3, type: 'tool.exec.end', data: { toolName: 'shell', hasError: true } });

    const snap = metrics.snapshot();
    expect(snap.toolErrors['shell']).toBe(1);
  });

  it('should track turns and empty responses', () => {
    const metrics = new MetricsAggregator();

    metrics.processEvent({ ts: Date.now(), level: 3, type: 'turn.start' });
    metrics.processEvent({ ts: Date.now(), level: 3, type: 'turn.end', data: { content: 'hello' } });

    metrics.processEvent({ ts: Date.now(), level: 3, type: 'turn.start' });
    metrics.processEvent({ ts: Date.now(), level: 3, type: 'turn.end', data: { content: '' } });

    const snap = metrics.snapshot();
    expect(snap.turnsTotal).toBe(2);
    expect(snap.emptyResponses).toBe(1);
  });

  it('should track retries', () => {
    const metrics = new MetricsAggregator();

    metrics.processEvent({ ts: Date.now(), level: 2, type: 'retry' });
    metrics.processEvent({ ts: Date.now(), level: 2, type: 'retry' });
    metrics.processEvent({ ts: Date.now(), level: 2, type: 'retry' });

    expect(metrics.snapshot().retriesTotal).toBe(3);
  });

  it('should estimate cost', () => {
    const metrics = new MetricsAggregator({
      costPerMillionTokens: { input: 3, output: 15 },
    });

    metrics.processEvent({ ts: Date.now(), level: 3, type: 'model.call.start' });
    metrics.processEvent({
      ts: Date.now(), level: 3, type: 'model.call.end',
      data: { usage: { promptTokens: 1_000_000, completionTokens: 500_000 } },
    });

    const snap = metrics.snapshot();
    // (1M / 1M) * $3 + (0.5M / 1M) * $15 = $3 + $7.5 = $10.5
    expect(snap.estimatedCostUsd).toBe(10.5);
  });

  it('should track active sessions', () => {
    const metrics = new MetricsAggregator();

    metrics.processEvent({ ts: Date.now(), level: 3, type: 'model.call.start', sessionId: 's1' });
    metrics.processEvent({ ts: Date.now(), level: 3, type: 'model.call.start', sessionId: 's2' });
    metrics.processEvent({ ts: Date.now(), level: 3, type: 'model.call.start', sessionId: 's1' }); // 重复

    expect(metrics.snapshot().sessionsActive).toBe(2);
  });

  it('should reset all metrics', () => {
    const metrics = new MetricsAggregator();

    metrics.processEvent({ ts: Date.now(), level: 3, type: 'model.call.start' });
    metrics.processEvent({ ts: Date.now(), level: 3, type: 'turn.start' });

    metrics.reset();

    const snap = metrics.snapshot();
    expect(snap.llmCalls).toBe(0);
    expect(snap.turnsTotal).toBe(0);
  });

  it('should format snapshot', () => {
    const metrics = new MetricsAggregator();
    metrics.processEvent({ ts: Date.now(), level: 3, type: 'model.call.start' });
    metrics.processEvent({ ts: Date.now(), level: 3, type: 'model.call.end', data: { usage: { promptTokens: 100, completionTokens: 50 } } });

    const formatted = formatMetricsSnapshot(metrics.snapshot());
    expect(formatted).toContain('📊 Agent Metrics');
    expect(formatted).toContain('LLM');
    expect(formatted).toContain('Calls');
  });
});

// ═══════════════════════════════════════════════════
// ScenarioComposer
// ═══════════════════════════════════════════════════

describe('ScenarioComposer', () => {

  it('should compose fragments with template params', () => {
    const fragment = {
      name: 'test',
      messages: ['创建文件 {filename}', '读取 {filename}'],
    };

    const scenario = compose('composed', [fragment], { filename: 'test.txt' });

    expect(scenario.name).toBe('composed');
    expect(scenario.messages).toEqual(['创建文件 test.txt', '读取 test.txt']);
  });

  it('should compose multiple fragments', () => {
    const f1 = { messages: ['step1'] };
    const f2 = { messages: ['step2', 'step3'] };

    const scenario = compose('multi', [f1, f2]);

    expect(scenario.messages).toEqual(['step1', 'step2', 'step3']);
  });

  it('should handle {random} template', () => {
    const fragment = { messages: ['create {random}.txt'] };
    const scenario = compose('random', [fragment]);

    expect(scenario.messages[0]).not.toContain('{random}');
    expect(scenario.messages[0]).toMatch(/^create \w+\.txt$/);
  });

  it('should extend scenario with extra assertions', () => {
    const base = {
      name: 'base',
      messages: ['msg1', 'msg2'],
      assertions: [[(r: any) => null], [(r: any) => null]],
    };

    const extended = extendScenario(base, {
      assertions: { 0: [(r: any) => r.toolCalls.length > 0 ? null : 'No tools'] },
    });

    expect(extended.messages.length).toBe(2);
    expect(extended.assertions?.[0].length).toBe(2); // 原始 + 扩展
    expect(extended.assertions?.[1].length).toBe(1); // 只有原始
  });

  it('should extend scenario with extra messages', () => {
    const base = {
      name: 'base',
      messages: ['msg1'],
    };

    const extended = extendScenario(base, {
      extraMessages: ['msg2', 'msg3'],
      extraAssertions: [[(r: any) => null]],
    });

    expect(extended.messages).toEqual(['msg1', 'msg2', 'msg3']);
  });

  it('should provide builtin scenarios', () => {
    const basic = BuiltinScenarios.basicChat();
    expect(basic.messages.length).toBe(1);

    const fileRw = BuiltinScenarios.fileReadWrite();
    expect(fileRw.messages.length).toBe(2);
    expect(fileRw.assertions?.length).toBe(2);

    const memory = BuiltinScenarios.sessionMemory();
    expect(memory.messages.length).toBe(2);

    const recovery = BuiltinScenarios.errorRecovery();
    expect(recovery.messages.length).toBe(2);

    const chain = BuiltinScenarios.toolChain();
    expect(chain.messages.length).toBe(1);
  });

  it('should compose builtin scenarios with params', () => {
    const fragment = BuiltinScenarios.fileReadWrite();
    const scenario = compose('test-file', [fragment], {
      filename: 'hello.txt',
      content: 'world',
    });

    expect(scenario.messages[0]).toContain('hello.txt');
    expect(scenario.messages[0]).toContain('world');
    expect(scenario.messages[1]).toContain('hello.txt');
  });
});
