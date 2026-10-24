/**
 * LoopObserver LLM 计时契约（F3-c：[timing] 探针转正）
 *
 * 锁三件事：
 * 1. 循环真实产出 onLLMStart(callId/reqChars) / onLLMFirstToken(ttftMs) / onLLMEnd(ttft/outChars/finishReason)
 * 2. createRunTelemetry 按 callId 隔离计时——同 agent 并发 run 共用一个 observer，
 *    单变量 llmStartTs 会互相覆盖（F3-b 评审发现的竞态）
 * 3. ttftMs 经 model.call.end 白名单落盘（回归指标口径：long-session-latency §7）
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@octopi-agent/engine/harness/run/agent/agent.js';
import type {
  ModelProvider,
  LLMResponse,
  LLMStreamChunk,
} from '@octopi-agent/core/interfaces/model-provider.js';
import type { ReliabilityHarness } from '@octopi-agent/core/interfaces/reliability.js';
import type { LoopObserver } from '@octopi-agent/core/loop/types.js';
import { createTelemetryFactoryFromConfig } from '@octopi-agent/engine/config.js';

function streamingProvider(): ModelProvider {
  return {
    name: 'test',
    defaultModel: 'test',
    getModelInfo: () => null,
    getModelInfos: () => [],
    async chat(): Promise<LLMResponse> {
      return { content: 'hi', model: 'test', finishReason: 'stop' };
    },
    async *stream(): AsyncGenerator<LLMStreamChunk> {
      yield { type: 'content', content: 'he' };
      await new Promise((r) => setTimeout(r, 5));
      yield { type: 'content', content: 'llo' };
      yield { type: 'done', finishReason: 'stop' };
    },
    async isAvailable() {
      return true;
    },
  };
}

function createHarness(): ReliabilityHarness {
  return {
    config: {
      planningRetry: { maxAttempts: 0, steerInstruction: '' },
      emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
      noopThreshold: 3,
      loopDetection: { enabled: false },
    },
  };
}

describe('agentLoop 计时回调（真实循环）', () => {
  it('onLLMStart/onLLMFirstToken/onLLMEnd 全链路带 callId 与计时', async () => {
    const calls: Record<string, Array<Record<string, unknown>>> = {
      start: [],
      firstToken: [],
      end: [],
    };
    const observer: LoopObserver = {
      onLLMStart: (p) => calls.start.push({ ...p }),
      onLLMFirstToken: (p) => calls.firstToken.push({ ...p }),
      onLLMEnd: (p) => calls.end.push({ ...p }),
    };

    const agent = new Agent({ model: streamingProvider(), harness: createHarness(), observer });
    agent.context.messages.push({ role: 'user', content: 'say hi', timestamp: Date.now() });
    const loopEvents: Array<Record<string, unknown>> = [];
    for await (const ev of agent.run()) {
      loopEvents.push(ev as unknown as Record<string, unknown>);
    }

    expect(calls.start.length).toBeGreaterThanOrEqual(1);
    const start = calls.start[0] as { model: string; callId: string; reqChars?: number };
    expect(start.callId).toMatch(/^call_/);
    expect(start.reqChars).toBeGreaterThan(0);

    expect(calls.firstToken.length).toBeGreaterThanOrEqual(1);
    const first = calls.firstToken[0] as { callId: string; ttftMs: number };
    expect(first.callId).toBe(start.callId);
    expect(first.ttftMs).toBeGreaterThanOrEqual(0);

    expect(calls.end.length).toBeGreaterThanOrEqual(1);
    const end = calls.end[0] as {
      callId: string;
      ttftMs?: number;
      outChars?: number;
      finishReason?: string;
    };
    expect(end.callId).toBe(start.callId);
    expect(end.ttftMs).toBe(first.ttftMs);
    expect(end.outChars).toBeGreaterThan(0);
    expect(end.finishReason).toBe('stop');

    // F3-d：turn_end 协议事件携带 llmTiming（Run 页签耗时区的取数通道）
    const turnEnd = loopEvents.find((e) => e.type === 'turn_end') as
      | { llmTiming?: Record<string, unknown> }
      | undefined;
    expect(turnEnd?.llmTiming?.ttftMs).toBe(first.ttftMs);
    expect(turnEnd?.llmTiming?.durationMs as number).toBeGreaterThan(0);
    expect(turnEnd?.llmTiming?.reqChars).toBe(start.reqChars);
    expect(turnEnd?.llmTiming?.outChars).toBe(end.outChars);
  });
});

describe('createRunTelemetry 计时隔离（并发竞态）', () => {
  it('交错的两次调用各自计时、ttft 落盘，互不覆盖', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-trace-'));
    const factory = await createTelemetryFactoryFromConfig({ level: 3, traceDir: dir });
    const t = factory({ enableMetrics: true });
    const observer = t.createLoopObserver({});

    // c1 先开始，c2 后开始；c2 先结束——若共享计时起点，c2 的 duration 会被拉长到 c1 的起点
    observer.onLLMStart?.({ model: 'm', callId: 'c1' });
    await new Promise((r) => setTimeout(r, 20));
    observer.onLLMStart?.({ model: 'm', callId: 'c2' });
    await new Promise((r) => setTimeout(r, 5));
    observer.onLLMFirstToken?.({ model: 'm', callId: 'c2', ttftMs: 5 });
    observer.onLLMEnd?.({ model: 'm', callId: 'c2', ttftMs: 5 });
    await new Promise((r) => setTimeout(r, 5));
    observer.onLLMFirstToken?.({ model: 'm', callId: 'c1', ttftMs: 30 });
    observer.onLLMEnd?.({ model: 'm', callId: 'c1', ttftMs: 30 });
    await t.finalize?.();

    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    const rows = readFileSync(join(dir, files[0]), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; data?: Record<string, unknown> });
    const ends = rows.filter((r) => r.type === 'model.call.end');
    expect(ends.length).toBe(2);
    const byId = new Map(ends.map((e) => [e.data?.callId, e.data]));
    // 共享起点会把 c2 拉到 c1 起点（d1≈d2）；隔离后 d1 - d2 ≈ 20ms。相对断言抗 CI 抖动
    const d1 = byId.get('c1')?.durationMs as number;
    const d2 = byId.get('c2')?.durationMs as number;
    expect(d1 - d2).toBeGreaterThanOrEqual(15);
    // ttft 经白名单落盘（回归指标口径）
    expect(byId.get('c1')?.ttftMs).toBe(30);
    expect(byId.get('c2')?.ttftMs).toBe(5);
  });
});

describe('错误路径计时收口', () => {
  it('stream+chat 双失败时 onLLMStart/onLLMEnd 成对（finishReason=error）', async () => {
    const failing: ModelProvider = {
      name: 'test',
      defaultModel: 'test',
      getModelInfo: () => null,
      getModelInfos: () => [],
      async chat(): Promise<LLMResponse> {
        throw new Error('chat down');
      },
      async *stream(): AsyncGenerator<LLMStreamChunk> {
        // 'error' chunk 触发 callModel 抛错 → fallback → chat 也失败 → agent-loop catch
        yield { type: 'error', error: 'stream down' };
      },
      async isAvailable() {
        return true;
      },
    };
    let starts = 0;
    const ends: Array<Record<string, unknown>> = [];
    const agent = new Agent({
      model: failing,
      harness: createHarness(),
      observer: {
        onLLMStart: () => starts++,
        onLLMEnd: (p) => ends.push({ ...p }),
      },
    });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });
    for await (const _ev of agent.run()) {
      // drain
    }

    // 失败也必须成对：否则 trace 孤儿 start + 计时 Map 残留 + 错误耗时被隐藏
    expect(starts).toBe(1);
    expect(ends.length).toBe(1);
    expect(ends[0].finishReason).toBe('error');
  });

  it('tool_call-only 响应也有 TTFT（首个任意 chunk 口径，样本不断档）', async () => {
    let call = 0;
    const toolOnly: ModelProvider = {
      name: 'test',
      defaultModel: 'test',
      getModelInfo: () => null,
      getModelInfos: () => [],
      async chat(): Promise<LLMResponse> {
        return { content: 'ok', model: 'test', finishReason: 'stop' };
      },
      async *stream(): AsyncGenerator<LLMStreamChunk> {
        if (call++ === 0) {
          yield {
            type: 'tool_call',
            toolCall: { id: 'c1', name: 'echo', arguments: '{"n":1}', index: 0 },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'content', content: 'done' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
      async isAvailable() {
        return true;
      },
    };
    const firstTokens: Array<Record<string, unknown>> = [];
    const agent = new Agent({
      model: toolOnly,
      harness: createHarness(),
      tools: [
        {
          name: 'echo',
          description: 'echo',
          execute: async (id, args) => ({ toolCallId: id, name: 'echo', content: JSON.stringify(args) }),
        },
      ],
      observer: {
        onLLMFirstToken: (p) => firstTokens.push({ ...p }),
      },
    });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });
    for await (const _ev of agent.run()) {
      // drain
    }

    // 两次 LLM 调用都要有 TTFT——旧口径只算正文/思考增量，tool_call-only 调用会被整体剔除
    expect(firstTokens.length).toBe(2);
    for (const f of firstTokens) {
      expect(f.ttftMs as number).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('trace-collector turn.end 去双计', () => {
  it('record：turn.end 只产 turn.end 行，不冒充 model.call.end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-trace-'));
    const factory = await createTelemetryFactoryFromConfig({ level: 3, traceDir: dir });
    const t = factory({ enableMetrics: true });
    t.onEvent?.(
      {
        type: 'turn.end',
        timestamp: Date.now(),
        data: { content: 'x', hasToolCalls: false, phase: 'final' },
      } as never,
      { sessionId: 's', agentId: 'a' },
    );
    await t.finalize?.();

    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    const rows = readFileSync(join(dir, files[0]), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string });
    expect(rows.filter((r) => r.type === 'model.call.end').length).toBe(0);
    expect(rows.filter((r) => r.type === 'turn.end').length).toBe(1);
  });

  it('wrap：事件流自带 turn.end 时不再补收口行（turn 统计不翻倍）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-trace-'));
    const { TraceCollector } = await import('@octopi-agent/engine/integration/observability/trace-collector.js');
    const collector = new TraceCollector({ outputDir: dir, level: 3, consoleLevel: null });
    async function* events(): AsyncGenerator<never> {
      yield {
        type: 'turn.end',
        timestamp: Date.now(),
        data: { content: 'x', hasToolCalls: false, phase: 'final' },
      } as never;
    }
    for await (const _ev of collector.wrap(events(), { sessionId: 's', agentId: 'a' })) {
      // drain
    }
    collector.finalize();

    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    const rows = readFileSync(join(dir, files[0]), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string });
    expect(rows.filter((r) => r.type === 'turn.end').length).toBe(1);
  });
});

describe('run.timing 落盘（run 级计时转正）', () => {
  it('run_start/context_ready/run_end 三 stage 经 onEvent 落 trace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-trace-'));
    const factory = await createTelemetryFactoryFromConfig({ level: 3, traceDir: dir });
    const t = factory({ enableMetrics: true });
    const ctx = { sessionId: 's', agentId: 'a' };
    t.onEvent?.({ type: 'run.timing', timestamp: Date.now(), data: { stage: 'run_start', waitMs: 3 } } as never, ctx);
    t.onEvent?.(
      { type: 'run.timing', timestamp: Date.now(), data: { stage: 'context_ready', buildMs: 7, msgs: 2, sysChars: 100, groundingTokens: 0 } } as never,
      ctx,
    );
    t.onEvent?.(
      { type: 'run.timing', timestamp: Date.now(), data: { stage: 'run_end', durMs: 20, reason: 'completed', loopEnd: 'completed' } } as never,
      ctx,
    );
    await t.finalize?.();

    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    const rows = readFileSync(join(dir, files[0]), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; data?: Record<string, unknown> });
    const timing = rows.filter((r) => r.type === 'run.timing');
    expect(timing.map((r) => r.data?.stage)).toEqual(['run_start', 'context_ready', 'run_end']);
    expect(timing[1].data?.buildMs).toBe(7);
    expect(timing[2].data?.reason).toBe('completed');
  });
});
