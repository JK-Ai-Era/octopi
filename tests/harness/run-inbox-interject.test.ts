/**
 * 插话 / 委派结果 inbox 接续 — SessionAwareRunner × SessionRunnerDispatcher 连线回归
 *
 * 不变量：
 * - 活跃 Run 在合法消息边界消费 inbox：每条注入输入开自己的 turn
 *   （闭上一 turn → 新 turn_start 一次定形），全回放 append-only
 * - 消费入上下文后 ack；委派结果 ack 驱动 deliveryAck（surfaced 因果锚点）
 * - Run 关闭仍未消费 → 按原 Trigger 重投恰好一次（不丢、不双跑）
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';
import type { Agent } from '@octopi-agent/engine/harness/run/agent/index.js';
import type { Message } from '@octopi-agent/core/types.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import { SessionInbox } from '@octopi-agent/engine/harness/activation/inbox.js';
import type {
  SessionInboxBinding,
  SessionInboxEntry,
} from '@octopi-agent/engine/harness/activation/inbox.js';
import { SessionRunnerDispatcher } from '@octopi-agent/engine/harness/activation/dispatcher.js';
import type {
  RunRequest,
  Trigger,
} from '@octopi-agent/engine/harness/activation/types.js';

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
    setOnAfterTurn: () => {},
    notifyAfterTurn: async () => {},
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

function triggerOf(id: string, extra: Partial<Trigger> = {}): Trigger {
  return {
    id,
    type: 'message',
    agentId: 'a1',
    sessionId: 's1',
    timestamp: Date.now(),
    payload: { kind: 'user_message', content: id },
    metadata: {},
    ...extra,
  };
}

function userEntry(id: string, text: string, extra: Partial<SessionInboxEntry> = {}): SessionInboxEntry {
  return {
    id,
    agentId: 'a1',
    sessionId: 's1',
    message: { role: 'user', content: text, timestamp: Date.now() },
    human: true,
    receivedAt: Date.now(),
    ...extra,
  };
}

describe('inbox 插话接续（Runner × Dispatcher）', () => {
  let home: string;

  async function setup(): Promise<{ store: JsonlSessionStore }> {
    home = await mkdtemp(join(tmpdir(), 'octopi-inbox-'));
    const store = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
    await store.save('s1', emptySession('s1'));
    return { store };
  }

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('活跃 Run 消费插话：闭上一 turn、新 turn 信封定形、入上下文后 ack', async () => {
    const { store } = await setup();
    const agent = scriptedAgent([
      {
        pushes: [{ role: 'assistant', content: 'answer-1', timestamp: Date.now() }],
        event: { type: 'turn_end', timestamp: Date.now(), usage: undefined },
      },
      {
        seam: true,
        pushes: [{ role: 'assistant', content: 'answer-2', timestamp: Date.now() }],
        event: { type: 'turn_end', timestamp: Date.now(), usage: undefined },
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

    // 第一个事件边界后 Run 已持锁并打开接收端
    await events.next();
    expect(
      binding.inbox.offer({
        agentId: 'a1',
        sessionId: 's1',
        message: { role: 'user', content: 'interject!', timestamp: Date.now() },
        entryId: 'h1',
        human: true,
      }),
    ).toBe('steered');

    while (!(await events.next()).done) {
      // 消费余下事件直到 Run 结束
    }

    const fresh = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
    const loaded = await fresh.load('s1');
    const texts = loaded!.messages.map((m) => String(m.content));
    // 有序全回放：t1(user hi) → answer-1 → 闭 t1 → t2(user interject!) → answer-2 → 闭 t2
    const iT1 = texts.findIndex((t) => t.includes('<turn_start') && t.includes('hi'));
    const iA1 = texts.indexOf('answer-1');
    const iE1 = texts.findIndex((t) => t.includes('<turn_end id="t1"'));
    const iT2 = texts.findIndex((t) => t.includes('<turn_start') && t.includes('interject!'));
    const iA2 = texts.indexOf('answer-2');
    const iE2 = texts.findIndex((t) => t.includes('<turn_end id="t2"'));
    expect(iT1).toBeGreaterThanOrEqual(0);
    expect(iA1).toBeGreaterThan(iT1);
    expect(iE1).toBeGreaterThan(iA1);
    expect(iT2).toBeGreaterThan(iE1);
    expect(iA2).toBeGreaterThan(iT2);
    expect(iE2).toBeGreaterThan(iA2);
    // 插话消息一次定形（write-once），并携带自己的 turnId
    expect(loaded!.messages[iT2]!.metadata?.turnId).toBe('t2');
  });

  it('委派结果消费/初始同步触发 deliveryAck（surfaced 因果锚点）', async () => {
    const { store } = await setup();
    const agent = scriptedAgent([
      // 原始 Loop 事件用 turn_start（adapt 映射为 iteration.start），确保先于 seam 挂起
      { event: { type: 'turn_start', timestamp: Date.now() } },
      { seam: true, event: { type: 'turn_end', timestamp: Date.now(), usage: undefined } },
    ]);
    const runner = new SessionAwareRunner(agent, {} as never, store);
    const acked: string[] = [];
    runner.setDelegationDeliveryAck((id) => acked.push(id));

    // wake 路径：委派结果作为初始输入（首同步 ack）
    const wake = userEntry('init-wake', 'result-wake', {
      human: false,
      message: {
        role: 'user',
        content: 'result-wake',
        timestamp: Date.now(),
        metadata: { delegationId: 'del-wake', source: 'runtime' },
      },
    });
    const binding: SessionInboxBinding = {
      inbox: new SessionInbox(() => {}),
      runId: 'r1',
      entries: [wake],
    };
    const events = runner.handle(
      's1',
      wake.message,
      { systemPrompt: '', agentId: 'a1', sessionId: 's1' },
      undefined,
      binding,
      wake,
    );
    await events.next();
    // 活跃 Run 内的委派结果（seam 消费 ack）
    binding.inbox.offer({
      agentId: 'a1',
      sessionId: 's1',
      message: {
        role: 'user',
        content: 'result-steered',
        timestamp: Date.now(),
        metadata: { delegationId: 'del-steered', source: 'runtime' },
      },
      entryId: 'del-steered',
    });
    for await (const _ev of events) {
      // 消费余下事件直到 Run 结束
    }

    expect(acked).toContain('del-wake');
    expect(acked).toContain('del-steered');
  });

  it('Run 关闭未消费：按原 Trigger 重投恰好一次（带 onEvent）', async () => {
    const { store } = await setup();
    // 无 seam：注入的消息无人消费
    const agent = scriptedAgent([
      {
        pushes: [{ role: 'assistant', content: 'answer-1', timestamp: Date.now() }],
        event: { type: 'turn_end', timestamp: Date.now(), usage: undefined },
      },
    ]);
    const runner = new SessionAwareRunner(agent, {} as never, store);
    const redispatch = vi.fn(async () => {});
    const dispatcher = new SessionRunnerDispatcher({ runner, redispatch });

    const req: RunRequest = {
      requestId: 'req-1',
      triggers: [triggerOf('t-init')],
      agentId: 'a1',
      sessionId: 's1',
      messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
    };
    const events = dispatcher.execute(req)[Symbol.asyncIterator]();
    await events.next();
    const onEvent = vi.fn();
    const trigger = triggerOf('t-del', { type: 'agent_signal' });
    expect(
      dispatcher.inbox.offer({
        agentId: 'a1',
        sessionId: 's1',
        message: {
          role: 'user',
          content: '<delegation_result id="del-x" status="completed"/>',
          timestamp: Date.now(),
          metadata: { delegationId: 'del-x', source: 'runtime' },
        },
        entryId: 'del-x',
        trigger,
        onEvent,
      }),
    ).toBe('steered');

    while (!(await events.next()).done) {
      // 消费余下事件直到 Run 结束
    }

    await vi.waitFor(() => expect(redispatch).toHaveBeenCalledTimes(1));
    const [triggerArg, options] = redispatch.mock.calls[0] as unknown as [
      Trigger,
      { onEvent?: (event: unknown) => void },
    ];
    expect(triggerArg).toBe(trigger);
    expect(triggerArg.id).toBe('t-del');
    expect(options?.onEvent).toBe(onEvent);
    // 已 ack 的插话不得再触发重投
    expect(redispatch).toHaveBeenCalledTimes(1);
  });

  it('转录同步失败且收尾 save 失败：已消费条目按原 Trigger 重投（评审 F6/F8）', async () => {
    const { store } = await setup();
    const agent = scriptedAgent([
      { event: { type: 'turn_start', timestamp: Date.now() } },
      { seam: true, event: { type: 'turn_end', timestamp: Date.now(), usage: undefined } },
    ]);
    // 同步恒失败 + 收尾权威写也失败 → ack 永不成立 → close 必须重投
    const failingStore = {
      load: (id: string) => store.load(id),
      save: async () => {
        throw new Error('disk full');
      },
      syncMessages: async () => {
        throw new Error('sync failed');
      },
      list: () => store.list(),
      delete: (id: string) => store.delete(id),
      exists: (id: string) => store.exists(id),
    } as unknown as JsonlSessionStore;
    const runner = new SessionAwareRunner(agent, {} as never, failingStore);
    const redispatch = vi.fn(async () => {});
    const inbox = new SessionInbox(redispatch);
    const initial = userEntry('init', 'hi');
    const binding: SessionInboxBinding = { inbox, runId: 'r1', entries: [initial] };
    const events = runner.handle(
      's1',
      initial.message,
      { systemPrompt: '', agentId: 'a1', sessionId: 's1' },
      undefined,
      binding,
      initial,
    );
    await events.next();
    const trigger = triggerOf('t-del', { type: 'agent_signal' });
    expect(
      inbox.offer({
        agentId: 'a1',
        sessionId: 's1',
        message: {
          role: 'user',
          content: 'result-x',
          timestamp: Date.now(),
          metadata: { delegationId: 'del-x', source: 'runtime' },
        },
        entryId: 'del-x',
        trigger,
      }),
    ).toBe('steered');

    await expect(async () => {
      while (!(await events.next()).done) {
        // 收尾 save 抛错从迭代抛出
      }
    }).rejects.toThrow('disk full');

    // 已消费但未确认 = 未送达：按原 Trigger 恰好重投一次
    await vi.waitFor(() => expect(redispatch).toHaveBeenCalledTimes(1));
    const [entry] = redispatch.mock.calls[0] as unknown as [SessionInboxEntry];
    expect(entry.id).toBe('del-x');
  });

  it('inbox.open 抛错不得跳过锁释放（评审 F7）', async () => {
    const { store } = await setup();
    const agent = scriptedAgent([
      { event: { type: 'turn_end', timestamp: Date.now(), usage: undefined } },
    ]);
    const runner = new SessionAwareRunner(agent, {} as never, store);
    const blockedInbox = new SessionInbox(async () => {});
    blockedInbox.open('s1', 'a1', 'r-block', []); // 占位：制造 already open
    const initial = userEntry('init', 'hi');
    const binding: SessionInboxBinding = {
      inbox: blockedInbox,
      runId: 'r1',
      entries: [initial],
    };
    await expect(async () => {
      while (!(await (runner.handle(
        's1',
        initial.message,
        { systemPrompt: '', agentId: 'a1', sessionId: 's1' },
        undefined,
        binding,
        initial,
      ) as AsyncGenerator<never, void, unknown>).next()).done) {
        // open 抛错应从首次迭代抛出
      }
    }).rejects.toThrow(/already open/);

    // 锁必须已释放：新的 handle（新 inbox）能正常跑完，否则测试超时
    const freshBinding: SessionInboxBinding = {
      inbox: new SessionInbox(async () => {}),
      runId: 'r3',
      entries: [userEntry('init2', 'hi2')],
    };
    const events = runner.handle(
      's1',
      freshBinding.entries[0]!.message,
      { systemPrompt: '', agentId: 'a1', sessionId: 's1' },
      undefined,
      freshBinding,
      freshBinding.entries[0],
    );
    for await (const _ev of events) {
      // 消费余下事件直到 Run 结束
    }
  });
});
