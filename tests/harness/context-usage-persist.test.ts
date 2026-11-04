/**
 * 上下文用量持久化回归（P0-C：三量纲单源分账）
 *
 * 语义：runner 收尾把最近一次 step.end 的三量纲账写入 session.metadata：
 * - promptTokensActual = provider 实测单源（无实测不更新、不猜；旧「全量估算兜底」已删）
 * - viewTokensEst = 请求视图估算（校准后，estimate 写入）
 * - rawTokens = 全量原文估算（只进 Run 页签展示，保留计算不删）
 * 每次写入打 `[ctx] writer=usage|stale|estimate|compact field=… value=…` 审计行。
 * 旧 metadata.contextTokens（混装实测/估算）为存量负债：显式清除，不映射为实测。
 *
 * 纪律：真 JsonlSessionStore round-trip + 换新实例重读。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import { makeTokenUsage } from '@octopi-agent/core/types/step.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { LLMRequest, LLMResponse } from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message, RegisteredTool } from '@octopi-agent/core/types.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';

function mockProvider(response: Partial<LLMResponse>): ModelProvider {
  return {
    name: 'mock',
    defaultModel: 'm',
    async chat(_req: LLMRequest) {
      return { content: 'ok', model: 'm', finishReason: 'stop' as const, ...response };
    },
    async *stream() {
      yield { type: 'done' as const };
    },
    async isAvailable() {
      return true;
    },
    getModelInfo() {
      return { name: 'm', contextWindow: 8000 };
    },
    getModelInfos() {
      return [{ name: 'm', contextWindow: 8000 }];
    },
  };
}

/** 按调用序返回不同响应（stale 审计红线：第一步有 usage、第二步无） */
function sequencedProvider(responses: Array<Partial<LLMResponse>>): ModelProvider {
  let call = 0;
  return {
    ...mockProvider({}),
    async chat(_req: LLMRequest) {
      const r = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return { content: 'ok', model: 'm', finishReason: 'stop' as const, ...r };
    },
  };
}

const echoTool: RegisteredTool = {
  definition: {
    name: 'echo',
    description: 'Echo text',
    parameters: { text: { type: 'string', description: 'text', required: true } },
  },
  handler: async (args) => `echo:${String((args as { text?: unknown }).text ?? '')}`,
};

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function emptySession(id: string, agentId = 'default'): SessionData {
  return {
    id,
    agentId,
    primaryAgentId: agentId,
    meta: {
      id,
      agentId,
      channelId: 'web',
      peerId: 'ui',
      status: 'idle',
      createdAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [],
    steps: [],
    metadata: {},
    tasks: [],
  };
}

async function runOnce(
  runner: {
    handle: (
      sid: string,
      msg: Message,
      cfg: { systemPrompt: string; agentId: string; sessionId: string },
    ) => AsyncGenerator<{ type: string; data?: Record<string, unknown> }>;
  },
  sessionId: string,
  text: string,
): Promise<Array<{ type: string; data?: Record<string, unknown> }>> {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
  // 必须完整耗尽 generator：runner.handle 的持久化在事件流之后，
  // break 于 engine.end 会跳过 store.save（既有 context-lease 测试的假绿来源）
  for await (const ev of runner.handle(sessionId, userMsg(text), {
    systemPrompt: '',
    agentId: 'default',
    sessionId,
  })) {
    events.push(ev);
  }
  return events;
}

function stepEnds(events: Array<{ type: string; data?: Record<string, unknown> }>) {
  return events.filter((e) => e.type === 'step.end');
}

describe('context size accounting persistence (three quantities, measured-only chip)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'octopi-ctx-usage-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists promptTokensActual/contextWindow from usage and survives a reread', async () => {
    const store = new JsonlSessionStore({ sessionsDir: dir });
    const provider = mockProvider({
      usage: makeTokenUsage({ promptTokens: 54321, completionTokens: 9 }),
    });
    const { runner } = await new AgentBuilder()
      .model(provider)
      .store(store)
      .build();
    // 生产路径：contextWindow 只认 run 级模型快照（Runner 不主动 getModelInfo）
    (runner as unknown as {
      setModelResolver: (fn: () => {
        ref: string; providerName: string; modelName: string; unknown?: never;
        provider: ModelProvider; contextWindow?: number; source: string; known: boolean; isOverride: boolean;
      }) => void;
    }).setModelResolver(() => ({
      ref: 'mock/m',
      providerName: 'mock',
      modelName: 'm',
      provider,
      contextWindow: 8000,
      source: 'config',
      known: true,
      isOverride: false,
    }));

    const events = await runOnce(runner as never, 's-usage', 'hi');

    // step.end 事件值 = usage 报告值（实测单源）
    const stepEnd = stepEnds(events)[0];
    expect(stepEnd?.data?.promptTokensActual).toBe(54321);
    // 估算分流照记：视图估算与原文估算都随 step.end 下发（rawTokens 不删）
    expect(typeof stepEnd?.data?.viewTokensEst).toBe('number');
    expect(stepEnd?.data?.rawTokens as number).toBeGreaterThan(0);

    // 换新实例重读：三量纲 + contextWindow 持久化保全
    const fresh = new JsonlSessionStore({ sessionsDir: dir });
    const reread = await fresh.load('s-usage');
    expect(reread).not.toBeNull();
    expect(reread!.metadata.promptTokensActual).toBe(54321);
    expect(typeof reread!.metadata.viewTokensEst).toBe('number');
    expect(reread!.metadata.rawTokens as number).toBeGreaterThan(0);
    expect(reread!.metadata.contextWindow).toBe(8000);
    // 事件值与持久值同源一致（不许 UI 恢复出第三个数）
    expect(reread!.metadata.promptTokensActual).toBe(stepEnd?.data?.promptTokensActual);
  });

  it('does not guess promptTokensActual when the provider reports no usage', async () => {
    const store = new JsonlSessionStore({ sessionsDir: dir });
    const { runner } = await new AgentBuilder()
      .model(mockProvider({}))
      .store(store)
      .build();

    const events = await runOnce(runner as never, 's-est', 'hello world');

    // 无实测不更新、不猜：事件与持久层都没有 promptTokensActual（估算不得冒充实测）
    const stepEnd = stepEnds(events)[0];
    expect('promptTokensActual' in (stepEnd?.data ?? {})).toBe(false);
    const fresh = new JsonlSessionStore({ sessionsDir: dir });
    const reread = await fresh.load('s-est');
    expect(reread!.metadata.promptTokensActual).toBeUndefined();
    // 估算分流照记（viewTokensEst/rawTokens 是别的量纲，不冒充、也不丢）
    expect(typeof reread!.metadata.viewTokensEst).toBe('number');
    expect(reread!.metadata.rawTokens as number).toBeGreaterThan(0);
  });

  it('stale writer: usage-less step after a usage step re-reports the last measurement', async () => {
    const store = new JsonlSessionStore({ sessionsDir: dir });
    const provider = sequencedProvider([
      // 第一步：带 usage 的 tool call；第二步：收尾、无 usage
      {
        usage: makeTokenUsage({ promptTokens: 11111, completionTokens: 3 }),
        finishReason: 'tool_calls' as const,
        toolCalls: [{ id: 't1', name: 'echo', arguments: { text: 'x' } }],
      },
      {},
    ]);
    const { runner } = await new AgentBuilder()
      .model(provider)
      .store(store)
      .tool(echoTool)
      .build();

    const events = await runOnce(runner as never, 's-stale', 'hi');
    const ends = stepEnds(events);
    expect(ends.length).toBe(2);
    // 第一步：usage 写入；第二步：沿用最近实测（stale），不是 undefined、更不是估算
    expect(ends[0]?.data?.promptTokensActual).toBe(11111);
    expect(ends[1]?.data?.promptTokensActual).toBe(11111);
  });

  it('does not overwrite promptTokensActual with compact-view values', async () => {
    const store = new JsonlSessionStore({ sessionsDir: dir });
    const { runner } = await new AgentBuilder()
      .model(mockProvider({
        usage: makeTokenUsage({ promptTokens: 42000, completionTokens: 5 }),
      }))
      .store(store)
      .build();

    await runOnce(runner as never, 's-compact', 'hi');
    const fresh = new JsonlSessionStore({ sessionsDir: dir });
    const reread = await fresh.load('s-compact');
    // 口径守护：持久值 = step.end 的实际 prompt，不是压缩后视图 tokens
    expect(reread!.metadata.promptTokensActual).toBe(42000);
  });

  it('drops legacy metadata.contextTokens instead of mapping it to promptTokensActual', async () => {
    const store = new JsonlSessionStore({ sessionsDir: dir });
    const seeded = emptySession('s-legacy');
    // 存量形状：旧字段混装过实测/估算，来源不可区分（937.5k 即估算冒充实测的事故值）
    seeded.metadata = { ...seeded.metadata, contextTokens: 937525, contextWindow: 8000 };
    await store.save('s-legacy', seeded);

    const provider = mockProvider({
      usage: makeTokenUsage({ promptTokens: 54321, completionTokens: 9 }),
    });
    const { runner } = await new AgentBuilder()
      .model(provider)
      .store(store)
      .build();
    await runOnce(runner as never, 's-legacy', 'hi');

    const fresh = new JsonlSessionStore({ sessionsDir: dir });
    const reread = await fresh.load('s-legacy');
    // 旧键显式清除（不浅合并残留），新实测单源补位
    expect(reread!.metadata.contextTokens).toBeUndefined();
    expect(reread!.metadata.promptTokensActual).toBe(54321);
  });

  it('keeps a pre-existing promptTokensActual untouched when the new run reports no usage', async () => {
    const store = new JsonlSessionStore({ sessionsDir: dir });
    const seeded = emptySession('s-keep');
    seeded.metadata = { promptTokensActual: 54321, contextWindow: 8000 };
    await store.save('s-keep', seeded);

    const { runner } = await new AgentBuilder()
      .model(mockProvider({}))
      .store(store)
      .build();
    await runOnce(runner as never, 's-keep', 'hello');

    const fresh = new JsonlSessionStore({ sessionsDir: dir });
    const reread = await fresh.load('s-keep');
    // 无实测不更新、不猜：旧实测原样保留（不被估算覆盖、不被清除），估算字段照常刷新
    expect(reread!.metadata.promptTokensActual).toBe(54321);
    expect(reread!.metadata.contextWindow).toBe(8000);
    expect(typeof reread!.metadata.viewTokensEst).toBe('number');
    expect(reread!.metadata.rawTokens as number).toBeGreaterThan(0);
  });

  it('emits [ctx] audit lines (writer=usage|stale|estimate) for every size write', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const store = new JsonlSessionStore({ sessionsDir: dir });
      const provider = sequencedProvider([
        {
          usage: makeTokenUsage({ promptTokens: 11111, completionTokens: 3 }),
          finishReason: 'tool_calls' as const,
          toolCalls: [{ id: 't1', name: 'echo', arguments: { text: 'x' } }],
        },
        {},
      ]);
      const { runner } = await new AgentBuilder()
        .model(provider)
        .store(store)
        .tool(echoTool)
        .build();
      await runOnce(runner as never, 's-audit', 'hi');

      const ctxLines = logSpy.mock.calls
        .map((args) => String(args[0] ?? ''))
        .filter((line) => line.startsWith('[ctx] '));
      // 每次写入一行，writer + field + value 三元组齐（600k 误显排查的盲区补洞）
      expect(ctxLines.some((l) => /^\[ctx\] session=s-audit writer=usage field=promptTokensActual value=11111$/.test(l))).toBe(true);
      expect(ctxLines.some((l) => /^\[ctx\] session=s-audit writer=stale field=promptTokensActual value=11111$/.test(l))).toBe(true);
      expect(ctxLines.some((l) => /^\[ctx\] session=s-audit writer=estimate field=viewTokensEst value=\d+$/.test(l))).toBe(true);
      expect(ctxLines.some((l) => /^\[ctx\] session=s-audit writer=estimate field=rawTokens value=\d+$/.test(l))).toBe(true);
      // 收尾持久化同样留痕
      expect(ctxLines.some((l) => / \(persist\)$/.test(l))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
