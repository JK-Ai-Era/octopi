/**
 * 上下文用量持久化回归（修复：重开会话后"上下文: 21.6k / 1.0m"显示错误）
 *
 * 语义：runner 收尾把最近一次 turn.end 的 contextTokens / contextWindow
 * （口径 = usage 报告值 ?? usage 分项和 ?? 全量估算）写入 session.metadata，
 * 重开会话经 getSessionView 恢复显示，不再用「末页 100 条消息」估算充数。
 *
 * 纪律：真 JsonlSessionStore round-trip + 换新实例重读。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import { makeTokenUsage } from '@octopi-agent/core/types/turn.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { LLMRequest, LLMResponse } from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message } from '@octopi-agent/core/types.js';

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

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
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

describe('context usage persistence (reopen shows last real usage)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'octopi-ctx-usage-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists the usage-reported contextTokens/contextWindow and survives a reread', async () => {
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

    // turn.end 事件值 = usage 报告值（既有口径）
    const turnEnd = events.find((e) => e.type === 'turn.end');
    expect(turnEnd?.data?.contextTokens).toBe(54321);

    // 换新实例重读：metadata 持久化保全
    const fresh = new JsonlSessionStore({ sessionsDir: dir });
    const reread = await fresh.load('s-usage');
    expect(reread).not.toBeNull();
    expect(reread!.metadata.contextTokens).toBe(54321);
    expect(reread!.metadata.contextWindow).toBe(8000);
    // 事件值与持久值同源一致（不许 UI 恢复出第三个数）
    expect(reread!.metadata.contextTokens).toBe(turnEnd?.data?.contextTokens);
  });

  it('persists the full-history estimate when the provider reports no usage', async () => {
    const store = new JsonlSessionStore({ sessionsDir: dir });
    const { runner } = await new AgentBuilder()
      .model(mockProvider({}))
      .store(store)
      .build();

    await runOnce(runner as never, 's-est', 'hello world');

    const fresh = new JsonlSessionStore({ sessionsDir: dir });
    const reread = await fresh.load('s-est');
    // 无 usage 时兜底为全量估算（必须是正数，不许 undefined 漏持久化）
    expect(typeof reread!.metadata.contextTokens).toBe('number');
    expect(reread!.metadata.contextTokens as number).toBeGreaterThan(0);
  });

  it('does not overwrite with compact-view values (only turn.end ledger writes)', async () => {
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
    // 口径守护：持久值 = turn.end 的实际 prompt，不是压缩后视图 tokens
    expect(reread!.metadata.contextTokens).toBe(42000);
  });
});
