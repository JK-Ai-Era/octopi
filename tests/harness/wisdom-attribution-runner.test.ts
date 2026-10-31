/**
 * Wisdom 归因窗口 — Runner 钩子集成（F5 回归锁）
 *
 * 锁住「run 收尾 → 归因窗口素材」的集成正确性：assistantTexts 只含本轮新增
 * assistant 文本（不含历史/用户文本）、outcome 反映 run 终态、无 manifest 不记账、
 * 记账失败不拖垮 run 收口。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import type { Agent } from '@octopi-agent/engine/harness/run/agent/index.js';
import type { Message } from '@octopi-agent/core/types.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { AssembleManifest } from '@octopi-agent/engine/harness/context/layer-types.js';
import type { WisdomRunWindowInfo } from '@octopi-agent/engine/harness/memory/wisdom-attribution.js';

function emptySession(id: string, agentId = 'a1'): SessionData {
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
    turns: [],
    metadata: {},
    tasks: [],
  };
}

/** 产出两条 assistant 文本（其中一条带范式引用）后正常收尾的 agent */
function scriptedAgent(kind: 'completed' | 'error', texts: string[]): Agent {
  return {
    context: { systemPrompt: '', messages: [] as Message[], tools: [] },
    contextSessionId: 'default',
    tools: [],
    model: { name: 'mock', defaultModel: 'm' },
    config: {},
    harness: {},
    setSystemPrompt: () => {},
    setContextSessionId: () => {},
    setSessionCompactState: () => {},
    getSessionCompactState: () => undefined,
    toolsForSession: () => [],
    setOnAfterTurn: () => {},
    notifyAfterTurn: async () => {},
    run: async function* (
      _s?: AbortSignal,
      _h?: unknown,
      opts?: { context?: { messages: Message[] } },
    ) {
      for (const t of texts) {
        opts?.context?.messages.push({ role: 'assistant', content: t, timestamp: Date.now() });
      }
      yield {
        type: 'turn_end',
        timestamp: Date.now(),
        hasToolCalls: false,
        phase: 'final',
        error: kind === 'error',
        usage: undefined,
      } as never;
      yield {
        type: 'agent_end',
        reason: kind,
        timestamp: Date.now(),
        ...(kind === 'error' ? { error: new Error('boom') } : {}),
      } as never;
    },
  } as unknown as Agent;
}

function manifestWithWisdom(ids: string[]): AssembleManifest {
  return {
    layers: [
      { id: 'wisdom', placement: 'snapshot', included: true, sources: ids },
      { id: 'runtime', placement: 'snapshot', included: false },
    ],
  } as unknown as AssembleManifest;
}

describe('Runner 归因窗口钩子', () => {
  let home: string;

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function runOnce(options: {
    kind: 'completed' | 'error';
    texts: string[];
    manifest?: AssembleManifest;
    sinkError?: boolean;
  }): Promise<{ captured: WisdomRunWindowInfo[]; runOk: boolean }> {
    home = await mkdtemp(join(tmpdir(), 'octopi-wisdom-attr-'));
    const store = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
    await store.save('s1', emptySession('s1'));
    const captured: WisdomRunWindowInfo[] = [];
    const runner = new SessionAwareRunner(
      scriptedAgent(options.kind, options.texts),
      {} as never,
      store,
      {} as never,
    );
    runner.setSystemPromptAssembler(async () => ({
      systemPrompt: 'sys',
      manifest: options.manifest,
    }));
    runner.setWisdomAttributionSink((info) => {
      if (options.sinkError) throw new Error('sink down');
      captured.push(info);
    });

    let runOk = true;
    try {
      for await (const _ev of runner.handle(
        's1',
        { role: 'user', content: '用户问题文本', timestamp: Date.now() } as Message,
        { agentId: 'a1' } as never,
      )) {
        // drain
      }
    } catch {
      runOk = false;
    }
    return { captured, runOk };
  }

  it('正常收尾：只取本轮 assistant 文本，含引用与结局', async () => {
    const { captured } = await runOnce({
      kind: 'completed',
      texts: ['第一轮回答', '我按 [wis_x] 的指引行动了'],
      manifest: manifestWithWisdom(['wis_x']),
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].outcome).toBe('completed');
    expect(captured[0].injectedIds).toEqual(['wis_x']);
    expect(captured[0].assistantTexts).toEqual(['第一轮回答', '我按 [wis_x] 的指引行动了']);
    // 不含用户文本 / 历史文本
    expect(captured[0].assistantTexts.join('\n')).not.toContain('用户问题文本');
  });

  it('error 终态照常记账，outcome 如实', async () => {
    const { captured } = await runOnce({
      kind: 'error',
      texts: ['失败前的回答'],
      manifest: manifestWithWisdom(['wis_x']),
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].outcome).toBe('error');
    expect(captured[0].assistantTexts).toEqual(['失败前的回答']);
  });

  it('无 manifest（自定义 assembler）不记账', async () => {
    const { captured } = await runOnce({
      kind: 'completed',
      texts: ['回答'],
    });
    expect(captured).toHaveLength(0);
  });

  it('sink 抛错不拖垮 run 收口（只告警）', async () => {
    const { captured, runOk } = await runOnce({
      kind: 'completed',
      texts: ['回答'],
      manifest: manifestWithWisdom(['wis_x']),
      sinkError: true,
    });
    expect(runOk).toBe(true);
    expect(captured).toHaveLength(0);
  });
});
