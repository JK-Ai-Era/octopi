/**
 * runner 打标接线回归（评审 del-5ca70159 P1-2）
 *
 * 老化 run 起点边界的全部效力依赖 `bakeTurnStart` 给锚点打 `metadata.runId`——
 * 手工构造 metadata 的计划层测试证明不了接线。本文件走真实 SessionAwareRunner +
 * SessionInbox 插话路径，钉三件事：
 * - run 首锚点与插话锚点都带 `metadata.runId`，且**同一 run 同一值**；
 * - JsonlSessionStore 落盘/重载后 runId 仍在（历史重放不退化回 turn 语义）；
 * - 用重载后的历史算老化计划：插话前的工具结果不被降级（接线直通保护语义）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';
import type { Agent } from '@octopi-agent/engine/harness/run/agent/index.js';
import type { Message } from '@octopi-agent/core/types.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import {
  SessionInbox,
  type SessionInboxBinding,
  type SessionInboxEntry,
} from '@octopi-agent/engine/harness/activation/inbox.js';
import {
  computeToolResultAgingPlan,
  resolveToolResultAgingOptions,
} from '@octopi-agent/engine/harness/context/tool-result-aging.js';

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
    steps: [],
    metadata: {},
    tasks: [],
  } as SessionData;
}

interface AgentStep {
  /** 事件前 push 进 run 视图的消息 */
  pushes?: Message[];
  /** push 之后 yield 的事件 */
  event?: Record<string, unknown>;
  /** true = 模拟 Loop 的消息边界：调用 consumeMessages 并把结果 push 进上下文 */
  seam?: boolean;
}

/** Fake Agent：重放「seam 消费 → push → 事件」时序（与 agent-loop 的写史顺序一致）。 */
function scriptedAgent(steps: AgentStep[]): Agent {
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
    setOnAfterStep: () => {},
    notifyAfterStep: async () => {},
    run: async function* (
      _s?: AbortSignal,
      _h?: unknown,
      opts?: {
        context?: { messages: Message[] };
        consumeMessages?: () => Promise<Message[]>;
      },
    ) {
      const messages = opts!.context!.messages;
      for (const step of steps) {
        if (step.seam) {
          const injected = (await opts?.consumeMessages?.()) ?? [];
          messages.push(...injected);
        }
        for (const m of step.pushes ?? []) messages.push(m);
        if (step.event) yield step.event as never;
      }
      yield { type: 'agent_end', reason: 'done', timestamp: Date.now() } as never;
    },
  } as unknown as Agent;
}

function userEntry(id: string, text: string): SessionInboxEntry {
  return {
    id,
    agentId: 'a1',
    sessionId: 's1',
    message: { role: 'user', content: text, timestamp: Date.now() },
    human: true,
    receivedAt: Date.now(),
  };
}

/** 胖工具结果（>400 指针目标，可被降级——用来分辨「保护生效」与「无候选」） */
function fatToolActivity(): Message[] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c-stamp-1', name: 'file_read', arguments: { path: 'src/a.ts', purpose: 'fixture' } }],
      timestamp: Date.now(),
    } as unknown as Message,
    {
      role: 'tool',
      content: '',
      toolResults: [{ toolCallId: 'c-stamp-1', name: 'file_read', result: `body ${'x'.repeat(800)}` }],
      timestamp: Date.now(),
    } as unknown as Message,
  ];
}

describe('bakeTurnStart 的 runId 打标接线（P1-2）', () => {
  let home: string;

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('run 首锚点与插话锚点同 runId、落盘重载仍在，且插话前结果不被老化', async () => {
    home = await mkdtemp(join(tmpdir(), 'octopi-runid-'));
    const store = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
    await store.save('s1', emptySession('s1'));

    const agent = scriptedAgent([
      {
        pushes: [...fatToolActivity(), { role: 'assistant', content: 'answer-1', timestamp: Date.now() }],
        event: { type: 'step_end', timestamp: Date.now(), usage: undefined },
      },
      {
        seam: true,
        pushes: [{ role: 'assistant', content: 'answer-2', timestamp: Date.now() }],
        event: { type: 'step_end', timestamp: Date.now(), usage: undefined },
      },
    ]);
    const runner = new SessionAwareRunner(agent, {} as never, store);

    const initial = userEntry('init', 'hi');
    const binding: SessionInboxBinding = {
      inbox: new SessionInbox(() => {}),
      runId: 'r1',
      entries: [initial],
    };
    const events = runner.handle(
      's1',
      initial.message,
      { systemPrompt: '', agentId: 'a1', sessionId: 's1' },
      undefined,
      binding,
      initial,
    );
    await events.next(); // Run 已持锁并打开 inbox
    expect(
      binding.inbox.offer({
        agentId: 'a1',
        sessionId: 's1',
        message: { role: 'user', content: 'interject!', timestamp: Date.now() },
        entryId: 'h1',
        human: true,
      }),
    ).toBe('continued');
    while (!(await events.next()).done) {
      // 消费余下事件直到 Run 结束
    }

    // 全部断言基于**重载**后的历史：落盘往返不丢 runId 才算接线成立
    const fresh = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
    const loaded = (await fresh.load('s1'))!;
    const anchors = loaded.messages.filter((m) => String(m.content).includes('<turn_start'));
    expect(anchors).toHaveLength(2); // run 首锚点 + 插话锚点
    const runIds = anchors.map((m) => m.metadata?.runId);
    expect(typeof runIds[0]).toBe('string');
    expect((runIds[0] as string).length).toBeGreaterThan(0);
    expect(runIds[1]).toBe(runIds[0]); // 同一 run：插话不换 run 归因

    // 接线直通保护语义：同 run 全保（旧 turn 语义下插话前 1 条胖结果会被降级）
    const plan = computeToolResultAgingPlan(
      loaded.messages,
      resolveToolResultAgingOptions({ rawWindow: 0, freezeBatch: 1 }),
    );
    expect(plan.agedIds.size).toBe(0);
  });
});
