/**
 * LLM 彻底失败留痕契约
 *
 * 事故（2026-10-27）：失败的 LLM 调用在账本里冒充正常回复——
 * `turn_end`(error=true) 的 turn 记录用上一次调用的完整回复或整 run 累积的部分
 * 流出当正文，`durationMs: 0` 且无 error 标记；彻底失败的 run 收口后，
 * 重载会话看不到任何失败痕迹。三条不变式：
 *
 * 1. 失败轮的 turn 记录必须带 `error: true`，正文只能是**本次调用**的部分流出；
 * 2. 彻底失败（agent_end.reason='error'）必须留下持久化的可见凭证（runStopped 消息）；
 * 3. 成功轮不受影响（正文=完整回复、无 error 标记）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTokenUsage } from '@octopi-agent/core/types/turn.js';
import { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import type { Agent } from '@octopi-agent/engine/harness/run/agent/index.js';
import type { Message } from '@octopi-agent/core/types.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';

interface LoopEvent {
  type: string;
  [key: string]: unknown;
}

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

/**
 * 按脚本产出事件流的 agent
 *
 * @param events - HarnessLoopEvent 形状的事件序列
 * @returns 可交给 SessionAwareRunner 的 agent
 */
function scriptedAgent(events: LoopEvent[]): Agent {
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
      opts?.context?.messages.push({ role: 'user', content: 'hi', timestamp: Date.now() });
      for (const event of events) {
        yield event as never;
      }
    },
  } as unknown as Agent;
}

/**
 * 跑一轮并返回落盘后的 session
 *
 * @param events - 脚本事件序列
 * @returns 持久化后重新读出的 SessionData
 */
async function runAndLoad(events: LoopEvent[]): Promise<SessionData> {
  const home = await mkdtemp(join(tmpdir(), 'octopi-run-failure-records-'));
  try {
    const store = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
    await store.save('s1', emptySession('s1'));
    const runner = new SessionAwareRunner(scriptedAgent(events), {} as never, store, {} as never);
    for await (const _ev of runner.handle(
      's1',
      { role: 'user', content: 'hi', timestamp: Date.now() } as Message,
      { agentId: 'a1' } as never,
    )) {
      // drain
    }
    const loaded = await store.load('s1');
    if (!loaded) throw new Error('session 未落盘');
    return loaded;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe('失败轮记账不冒充正常回复', () => {
  it('重试中的每次失败：turn 记录带 error 标记，正文只含本次调用的部分流出', async () => {
    const session = await runAndLoad([
      { type: 'llm_stream_delta', timestamp: 1, data: { delta: '第一段部分输出' } },
      { type: 'turn_end', timestamp: 2, hasToolCalls: false, phase: 'final', error: true, usage: undefined },
      { type: 'llm_stream_delta', timestamp: 3, data: { delta: '第二段部分输出' } },
      { type: 'turn_end', timestamp: 4, hasToolCalls: false, phase: 'final', error: true, usage: undefined },
      { type: 'agent_end', timestamp: 5, reason: 'error', error: new Error('upstream timeout') },
    ]);

    expect(session.turns).toHaveLength(2);
    expect(session.turns[0].error).toBe(true);
    expect(session.turns[0].output.content).toBe('第一段部分输出');
    expect(session.turns[1].error).toBe(true);
    // 不得累积/重复前一次尝试的部分流出
    expect(session.turns[1].output.content).toBe('第二段部分输出');
  });

  it('失败轮不得回落到上一次成功调用的完整回复（stale content 回归）', async () => {
    const session = await runAndLoad([
      { type: 'assistant_message', timestamp: 1, message: { role: 'assistant', content: '完整回复 A', timestamp: 1 } },
      { type: 'turn_end', timestamp: 2, hasToolCalls: false, phase: 'final', usage: undefined },
      { type: 'llm_stream_delta', timestamp: 3, data: { delta: 'B 的部分输出' } },
      { type: 'turn_end', timestamp: 4, hasToolCalls: false, phase: 'final', error: true, usage: undefined },
      { type: 'agent_end', timestamp: 5, reason: 'error', error: new Error('upstream timeout') },
    ]);

    expect(session.turns).toHaveLength(2);
    expect(session.turns[0].output.content).toBe('完整回复 A');
    expect(session.turns[0].error).toBeUndefined();
    expect(session.turns[1].output.content).toBe('B 的部分输出');
    expect(session.turns[1].error).toBe(true);
  });

  it('彻底失败必须留下持久化凭证（runStopped/llm_error），partial 不冒充 assistant 回复', async () => {
    const session = await runAndLoad([
      { type: 'llm_stream_delta', timestamp: 1, data: { delta: '无处安放的部分输出' } },
      { type: 'turn_end', timestamp: 2, hasToolCalls: false, phase: 'final', error: true, usage: undefined },
      { type: 'agent_end', timestamp: 3, reason: 'error', error: new Error('upstream timeout') },
    ]);

    const proof = session.messages.find(
      (m) => m.role === 'user' && m.metadata?.source === 'runStopped',
    );
    expect(proof).toBeDefined();
    expect(proof?.metadata?.stopReason).toBe('llm_error');
    expect(proof?.content).toContain('upstream timeout');
    expect(proof?.content).toContain('模型调用失败');

    // 失败的 partial 只进 turn 账本（带 error），不得作为 assistant 回复入历史
    const fakeReply = session.messages.find(
      (m) => m.role === 'assistant' && m.content === '无处安放的部分输出',
    );
    expect(fakeReply).toBeUndefined();
  });

  it('成功轮不受影响：正文=完整回复、无 error 标记、无失败凭证', async () => {
    const session = await runAndLoad([
      { type: 'assistant_message', timestamp: 1, message: { role: 'assistant', content: '正常回复', timestamp: 1 } },
      { type: 'turn_end', timestamp: 2, hasToolCalls: false, phase: 'final', usage: undefined },
      { type: 'agent_end', timestamp: 3, reason: 'completed' },
    ]);

    expect(session.turns).toHaveLength(1);
    expect(session.turns[0].error).toBeUndefined();
    expect(session.turns[0].output.content).toBe('正常回复');
    expect(session.messages.some((m) => m.metadata?.source === 'runStopped')).toBe(false);
    expect(session.metadata.lastStop).toBeUndefined();
  });

  it('零输出失败轮：正文为空也留 error 账本', async () => {
    const session = await runAndLoad([
      { type: 'turn_end', timestamp: 1, hasToolCalls: false, phase: 'final', error: true, usage: undefined },
      { type: 'agent_end', timestamp: 2, reason: 'error', error: new Error('upstream timeout') },
    ]);

    expect(session.turns).toHaveLength(1);
    expect(session.turns[0].error).toBe(true);
    expect(session.turns[0].output.content).toBe('');
  });

  it('失败后重试成功：失败残句与成功回复互不串染', async () => {
    const session = await runAndLoad([
      { type: 'llm_stream_delta', timestamp: 1, data: { delta: '失败的残句' } },
      { type: 'turn_end', timestamp: 2, hasToolCalls: false, phase: 'final', error: true, usage: undefined },
      { type: 'assistant_message', timestamp: 3, message: { role: 'assistant', content: '成功的回复', timestamp: 3 } },
      { type: 'turn_end', timestamp: 4, hasToolCalls: false, phase: 'final', usage: undefined },
      { type: 'agent_end', timestamp: 5, reason: 'completed' },
    ]);

    expect(session.turns).toHaveLength(2);
    expect(session.turns[0].error).toBe(true);
    expect(session.turns[0].output.content).toBe('失败的残句');
    expect(session.turns[1].error).toBeUndefined();
    expect(session.turns[1].output.content).toBe('成功的回复');
  });

  it('用户 abort 不产 llm_error 凭证（终止原因必须如实归 aborted）', async () => {
    const session = await runAndLoad([
      { type: 'llm_stream_delta', timestamp: 1, data: { delta: '被中断的部分' } },
      { type: 'turn_end', timestamp: 2, hasToolCalls: false, phase: 'final', error: true, usage: undefined },
      { type: 'agent_end', timestamp: 3, reason: 'aborted' },
    ]);

    expect(session.messages.some((m) => m.metadata?.source === 'runStopped')).toBe(false);
    expect(session.metadata.lastStop).toBeUndefined();
  });

  it('零 turn_end 的彻底失败：partial 只进 error 账本，不伪造 assistant 回复', async () => {
    const session = await runAndLoad([
      { type: 'llm_stream_delta', timestamp: 1, data: { delta: '夭折的输出' } },
      { type: 'agent_end', timestamp: 2, reason: 'error', error: new Error('upstream timeout') },
    ]);

    const records = session.turns.filter((t) => t.error);
    expect(records).toHaveLength(1);
    expect(records[0].output.content).toBe('夭折的输出');
    expect(session.messages.some((m) => m.role === 'assistant')).toBe(false);
    expect(
      session.messages.some((m) => m.metadata?.source === 'runStopped' && m.metadata?.stopReason === 'llm_error'),
    ).toBe(true);
  });

  it('失败轮不得写入 usage（即便事件带了上一次调用的用量）', async () => {
    const staleUsage = makeTokenUsage({ promptTokens: 100, completionTokens: 50 });
    const session = await runAndLoad([
      { type: 'assistant_message', timestamp: 1, message: { role: 'assistant', content: '上一调用', timestamp: 1 } },
      { type: 'turn_end', timestamp: 2, hasToolCalls: false, phase: 'final', usage: staleUsage },
      {
        type: 'turn_end',
        timestamp: 3,
        hasToolCalls: false,
        phase: 'final',
        error: true,
        usage: staleUsage,
      },
      { type: 'agent_end', timestamp: 4, reason: 'error', error: new Error('upstream timeout') },
    ]);

    expect(session.turns).toHaveLength(2);
    expect(session.turns[0].usage).toBeDefined();
    expect(session.turns[1].error).toBe(true);
    expect(session.turns[1].usage).toBeUndefined();
  });

  it('残句并入失败凭证消息：重载后残句可见，且标明非完整回复', async () => {
    const session = await runAndLoad([
      { type: 'llm_stream_delta', timestamp: 1, data: { delta: '一段还没写完的输出' } },
      { type: 'turn_end', timestamp: 2, hasToolCalls: false, phase: 'final', error: true, usage: undefined },
      { type: 'agent_end', timestamp: 3, reason: 'error', error: new Error('upstream timeout') },
    ]);

    const proof = session.messages.find((m) => m.metadata?.source === 'runStopped');
    expect(proof?.content).toContain('一段还没写完的输出');
    expect(proof?.content).toContain('中断前的部分输出');
    expect(proof?.content).toContain('非完整回复');
  });

  it('残句附带按上限截断；turn 账本仍保完整残句', async () => {
    const longPartial = 'x'.repeat(3000);
    const session = await runAndLoad([
      { type: 'llm_stream_delta', timestamp: 1, data: { delta: longPartial } },
      { type: 'turn_end', timestamp: 2, hasToolCalls: false, phase: 'final', error: true, usage: undefined },
      { type: 'agent_end', timestamp: 3, reason: 'error', error: new Error('upstream timeout') },
    ]);

    const proof = session.messages.find((m) => m.metadata?.source === 'runStopped');
    expect(proof?.content).toContain('已截断');
    expect(session.turns.find((t) => t.error)?.output.content).toBe(longPartial);
  });

  it('成功轮 + 零 delta 失败：上一轮完整回复不得被标成「中断前的部分输出」', async () => {
    const session = await runAndLoad([
      { type: 'llm_stream_delta', timestamp: 1, data: { delta: '上一轮的完整回复' } },
      { type: 'assistant_message', timestamp: 2, message: { role: 'assistant', content: '上一轮的完整回复', timestamp: 2 } },
      { type: 'turn_end', timestamp: 3, hasToolCalls: false, phase: 'final', usage: undefined },
      // 第二次调用零 delta 直接 abort（不产 turn_end）→ lastTurnContent 停在成功轮
      { type: 'agent_end', timestamp: 4, reason: 'error', error: new Error('connect ECONNREFUSED') },
    ]);

    const proof = session.messages.find((m) => m.metadata?.source === 'runStopped');
    expect(proof?.content).toContain('connect ECONNREFUSED');
    expect(proof?.content).not.toContain('中断前的部分输出');
  });
});
