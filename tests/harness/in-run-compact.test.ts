/**
 * in-run 手动压缩（方案 A，2026-11-20 拍板）行为钉
 *
 * 语义：run 进行中的手动压缩 =「主动压缩立即触发」——请求交活跃 run 在下一个
 * 消息缝执行同一条 compact 路径（同保护/同摘要/同 transform 记录），不排
 * session 锁（持锁排队 = run 结束才执行，正是要修的意图落空）。
 *
 * 对照基线见 compact-session-lock.test.ts：锁路径断言 compact 在 run:end 之后；
 * in-run 路径断言 compact 在 run:end 之前（缝执行）。
 */

import { describe, it, expect } from 'vitest';
import {
  SessionAwareRunner,
  InRunCompactUnavailable,
} from '@octopi-agent/engine/harness/run/runner.js';
import type { Agent } from '@octopi-agent/engine/harness/run/agent/index.js';
import type { Message } from '@octopi-agent/core/types.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { InMemoryTransformStore } from '@octopi-agent/engine/harness/session/transform-store.js';

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
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 会走 consumeMessages 消息缝的 mock agent（真实 Loop 语义：每步消费注入） */
function makeSeamAgent(opts: {
  order: string[];
  /** step 中途回调：测试在此发 requestInRunCompact（run 进行中） */
  onRequest?: () => void;
  /** 是否走到消息缝（false = run 结束前没缝，测残留 reject） */
  hitSeam?: boolean;
  /** 消息缝次数（默认 1） */
  seamCount?: number;
  /** 第 i 次缝之后的回调（测 drain 后新请求） */
  seamHooks?: Array<() => void>;
}): Agent {
  const agentContext = { systemPrompt: '', messages: [] as Message[], tools: [] as unknown[] };
  const agent = {
    context: agentContext,
    contextSessionId: 'default',
    tools: [] as unknown[],
    model: { name: 'mock', defaultModel: 'm' },
    config: {},
    harness: {},
    setSystemPrompt: () => {},
    setContextSessionId: (sid: string) => {
      (agent as { contextSessionId: string }).contextSessionId = sid;
    },
    setSessionCompactState: () => {},
    getSessionCompactState: () => undefined,
    toolsForSession: () => [],
    setOnAfterStep: () => {},
    notifyAfterStep: async () => {},
    run: async function* (
      _signal?: AbortSignal,
      _h?: unknown,
      runOpts?: {
        context?: { messages: Message[] };
        consumeMessages?: () => Promise<Message[]>;
      },
    ) {
      const ctx = runOpts?.context;
      if (ctx) {
        ctx.messages.push({ role: 'assistant', content: 'working', timestamp: Date.now() });
      }
      opts.onRequest?.();
      const seams = opts.hitSeam === false ? 0 : (opts.seamCount ?? 1);
      for (let i = 0; i < seams; i++) {
        if (runOpts?.consumeMessages) await runOpts.consumeMessages(); // 消息缝：in-run 压缩执行点
        opts.seamHooks?.[i]?.();
      }
      if (ctx) {
        ctx.messages.push({ role: 'assistant', content: 'done', timestamp: Date.now() });
      }
      opts.order.push('run:end');
      yield { type: 'step_end', timestamp: Date.now(), usage: undefined } as never;
      yield { type: 'agent_end', reason: 'done', timestamp: Date.now() } as never;
    },
  };
  return agent as unknown as Agent;
}

function stubCompact(order: string[]): {
  compactStructural: () => Promise<{
    ok: true;
    compacted: true;
    reason: string;
    tokensBefore: number;
    tokensAfter: number;
    summary: string;
    summarizeAttempted: boolean;
    view: Message[];
  }>;
} {
  return {
    compactStructural: async () => {
      order.push('compact');
      return {
        ok: true,
        compacted: true,
        reason: 'structural',
        tokensBefore: 10,
        tokensAfter: 4,
        summary: 'compacted-sum',
        summarizeAttempted: true,
        view: [],
      };
    },
  };
}

describe('in-run 手动压缩（方案 A）', () => {
  it('run 进行中的请求在下一个消息缝执行（先于 run:end，对照锁路径的 >）', async () => {
    const order: string[] = [];
    let compactPromise: Promise<unknown> | undefined;
    const onRequest = (): void => {
      order.push('request');
      compactPromise = runner.requestInRunCompact('s-inrun', 'a1', stubCompact(order));
    };
    const agent = makeSeamAgent({ order, onRequest });
    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store);
    await store.save('s-inrun', emptySession('s-inrun', 'a1'));

    const handlePromise = (async () => {
      for await (const _ of runner.handle(
        's-inrun',
        { role: 'user', content: 'hi', timestamp: Date.now() },
        { systemPrompt: '', agentId: 'a1', sessionId: 's-inrun' },
      )) {
        void _;
      }
    })();

    await handlePromise;
    expect(compactPromise).toBeDefined();
    const result = (await compactPromise) as { summary?: string };
    expect(result.summary).toBe('compacted-sum');

    const requestIdx = order.indexOf('request');
    const compactIdx = order.indexOf('compact');
    const runEnd = order.indexOf('run:end');
    expect(requestIdx).toBeGreaterThanOrEqual(0);
    expect(compactIdx).toBeGreaterThan(requestIdx);
    expect(compactIdx).toBeLessThan(runEnd); // 缝执行：run 结束前完成（锁路径是 >）
  });

  it('同 (sessionId, agentId) 并发请求 coalesce 到一次缝执行', async () => {
    const order: string[] = [];
    let p1: Promise<unknown> | undefined;
    let p2: Promise<unknown> | undefined;
    const onRequest = (): void => {
      p1 = runner.requestInRunCompact('s-co', 'a1', stubCompact(order));
      p2 = runner.requestInRunCompact('s-co', 'a1', stubCompact(order));
    };
    const agent = makeSeamAgent({ order, onRequest });
    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store);
    await store.save('s-co', emptySession('s-co', 'a1'));

    for await (const _ of runner.handle(
      's-co',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'a1', sessionId: 's-co' },
    )) {
      void _;
    }

    expect(p1).toBeDefined();
    expect(p1).toBe(p2); // 同一承诺（coalesce，不重复烧 LLM）
    await p1;
    expect(order.filter((o) => o === 'compact')).toHaveLength(1);
  });

  it('无活跃 run → InRunCompactUnavailable（调用方 fallback 锁路径）', async () => {
    const order: string[] = [];
    const agent = makeSeamAgent({ order });
    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store);
    await expect(
      runner.requestInRunCompact('s-none', 'a1', stubCompact(order)),
    ).rejects.toBeInstanceOf(InRunCompactUnavailable);
  });

  it('run 结束前没走到缝 → 残留请求 reject（fallback 信号，不悬空承诺）', async () => {
    const order: string[] = [];
    let compactPromise: Promise<unknown> | undefined;
    const onRequest = (): void => {
      compactPromise = runner.requestInRunCompact('s-noseam', 'a1', stubCompact(order));
    };
    const agent = makeSeamAgent({ order, onRequest, hitSeam: false });
    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store);
    await store.save('s-noseam', emptySession('s-noseam', 'a1'));

    for await (const _ of runner.handle(
      's-noseam',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'a1', sessionId: 's-noseam' },
    )) {
      void _;
    }

    expect(compactPromise).toBeDefined();
    await expect(compactPromise).rejects.toBeInstanceOf(InRunCompactUnavailable);
    expect(order).not.toContain('compact'); // 未执行，由调用方 fallback 锁路径
    await sleep(1); // 平衡异步
  });

  it('真实 compactStructural：transform 记录 +1 且 contextSize 同步活对象（F2/F6 钉）', async () => {
    const order: string[] = [];
    const store = new InMemorySessionStore();
    const transformStore = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({ transformStore });
    const sess = emptySession('s-real', 'a1');
    // 摘要素材：跨过 protectFirstN/protectLastN 的中段
    for (let i = 0; i < 30; i++) {
      sess.messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${i} ` + 'x'.repeat(400),
        timestamp: Date.now() + i,
      } as Message);
    }
    await store.save('s-real', sess);

    let compactPromise: Promise<unknown> | undefined;
    const onRequest = (): void => {
      compactPromise = runner.requestInRunCompact('s-real', 'a1', {
        compactStructural: (input) =>
          engine.compactStructural({
            ...input,
            summarize: async () => '## Conversation Summary\nsum-real',
          }),
      });
    };
    const agent = makeSeamAgent({ order, onRequest });
    const runner = new SessionAwareRunner(agent, {} as never, store);

    for await (const _ of runner.handle(
      's-real',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'a1', sessionId: 's-real' },
    )) {
      void _;
    }

    const result = (await compactPromise) as {
      compacted: boolean;
      contextSize?: { tokens: number };
    };
    expect(result.compacted).toBe(true);
    // 真实压缩路径确实走了：transform 记录落账（stub 覆盖不到的「同一条路径」）
    const bucket = await transformStore.load('s-real', 'a1');
    expect(bucket.records.length).toBeGreaterThan(0);
    // F2 钉：contextSize 同步活对象 → 收尾整包 save 不会用旧值盖回
    const after = await store.load('s-real');
    expect(after?.metadata?.contextSize).toEqual(result.contextSize);
  });

  it('drain 后新请求走下一缝再执行（不吞请求）', async () => {
    const order: string[] = [];
    let p1: Promise<unknown> | undefined;
    let p2: Promise<unknown> | undefined;
    const onRequest = (): void => {
      p1 = runner.requestInRunCompact('s-2seams', 'a1', stubCompact(order));
    };
    const seamHooks = [
      (): void => {
        // 第一次 drain 已完成之后才发（seamHooks 在缝后调用）
        p2 = runner.requestInRunCompact('s-2seams', 'a1', stubCompact(order));
      },
    ];
    const agent = makeSeamAgent({ order, onRequest, seamCount: 2, seamHooks });
    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store);
    await store.save('s-2seams', emptySession('s-2seams', 'a1'));

    for await (const _ of runner.handle(
      's-2seams',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'a1', sessionId: 's-2seams' },
    )) {
      void _;
    }

    await p1;
    await p2;
    expect(order.filter((o) => o === 'compact')).toHaveLength(2); // 两次缝各执行一次
  });

  it('执行期间的点击 join 当前执行（F5 in-flight coalesce：不烧第二次）', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const startedGate = new Promise<void>((r) => {
      started = r;
    });
    let p1: Promise<unknown> | undefined;
    const onRequest = (): void => {
      p1 = runner.requestInRunCompact('s-inflight', 'a1', {
        compactStructural: async () => {
          order.push('compact:start');
          started();
          await gate; // 模拟摘要 LLM 调用（执行中窗口）
          order.push('compact:end');
          return {
            ok: true,
            compacted: true,
            reason: 'structural',
            tokensBefore: 10,
            tokensAfter: 4,
            summary: 's',
            summarizeAttempted: true,
            view: [],
          };
        },
      });
    };
    const agent = makeSeamAgent({ order, onRequest });
    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store);
    await store.save('s-inflight', emptySession('s-inflight', 'a1'));

    const handlePromise = (async () => {
      for await (const _ of runner.handle(
        's-inflight',
        { role: 'user', content: 'hi', timestamp: Date.now() },
        { systemPrompt: '', agentId: 'a1', sessionId: 's-inflight' },
      )) {
        void _;
      }
    })();

    await startedGate; // 第一次执行已开始（挂在 gate 上）
    const p2 = runner.requestInRunCompact('s-inflight', 'a1', stubCompact(order)); // join in-flight
    release();
    await handlePromise;

    const r1 = await p1;
    const r2 = await p2;
    expect(order.filter((o) => o === 'compact:start')).toHaveLength(1); // 没烧第二次
    expect(r2).toBe(r1); // join 同一份执行结果
  });
});
