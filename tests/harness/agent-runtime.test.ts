/**
 * Agent Runtime P0 — 激活宿主
 */

import { describe, it, expect } from 'vitest';
import {
  AgentRuntime,
  ExplicitRouter,
  CoalesceBuffer,
  compileMessages,
  RuntimeEvents,
} from '../../src/harness/agent-runtime/index.js';
import type {
  DispatchResult,
  RunDispatcher,
  RunRequest,
  RuntimeAgent,
  Trigger,
  TriggerSource,
} from '../../src/harness/agent-runtime/index.js';
import type { AgentEvent } from '../../src/core/primitives/event-bus.js';
import { DefaultEventBus } from '../../src/core/index.js';

// ── helpers ──

function trigger(partial: Partial<Trigger> & { id: string }): Trigger {
  return {
    type: 'manual',
    payload: { kind: 'user_message', content: 'hello' },
    ...partial,
  };
}

function mockDispatcher(
  onExecute?: (req: RunRequest) => void,
  options?: { delayMs?: number; throw?: boolean },
): RunDispatcher & { calls: RunRequest[] } {
  const calls: RunRequest[] = [];
  return {
    calls,
    async *execute(req: RunRequest): AsyncIterable<AgentEvent> {
      calls.push(req);
      onExecute?.(req);
      if (options?.delayMs) {
        await new Promise((r) => setTimeout(r, options.delayMs));
      }
      if (options?.throw) {
        throw new Error('boom');
      }
      yield { type: 'engine.start', timestamp: Date.now(), data: {} } as AgentEvent;
      yield { type: 'engine.end', timestamp: Date.now(), data: {} } as AgentEvent;
    },
  };
}

function agent(
  id: string,
  dispatcher: RunDispatcher,
  resolveSession?: RuntimeAgent['resolveSession'],
): RuntimeAgent {
  return { agentId: id, dispatcher, resolveSession };
}

// ── ExplicitRouter ──

describe('ExplicitRouter', () => {
  it('显式 agentId', async () => {
    const router = new ExplicitRouter();
    const d = mockDispatcher();
    const agents = new Map([['a1', agent('a1', d)]]);
    const targets = await router.resolve(trigger({ id: 't1', agentId: 'a1' }), agents);
    expect(targets).toEqual([{ agentId: 'a1', sessionId: undefined }]);
  });

  it('未知 agentId → 空', async () => {
    const router = new ExplicitRouter();
    const agents = new Map([['a1', agent('a1', mockDispatcher())]]);
    const targets = await router.resolve(trigger({ id: 't1', agentId: 'nope' }), agents);
    expect(targets).toEqual([]);
  });

  it('toAgents fan-out', async () => {
    const router = new ExplicitRouter();
    const agents = new Map([
      ['a1', agent('a1', mockDispatcher())],
      ['a2', agent('a2', mockDispatcher())],
    ]);
    const targets = await router.resolve(
      trigger({ id: 't1', toAgents: ['a1', 'a2', 'missing'] }),
      agents,
    );
    expect(targets.map((t) => t.agentId)).toEqual(['a1', 'a2']);
  });

  it('fallbackAgentId', async () => {
    const router = new ExplicitRouter({ fallbackAgentId: 'only' });
    const agents = new Map([['only', agent('only', mockDispatcher())]]);
    const targets = await router.resolve(trigger({ id: 't1' }), agents);
    expect(targets[0]?.agentId).toBe('only');
  });
});

// ── Compiler ──

describe('compiler', () => {
  it('非 message 触发带 runtime metadata', () => {
    const msgs = compileMessages([
      trigger({ id: 't1', type: 'schedule', payload: { kind: 'system_note', content: 'tick' } }),
    ]);
    expect(msgs[0]?.role).toBe('user');
    expect(msgs[0]?.content).toBe('tick');
    expect((msgs[0] as { metadata?: Record<string, unknown> }).metadata?.source).toBe('runtime');
  });

  it('通道 user_message 不打 runtime 标记，且保留 timestamp', () => {
    const msgs = compileMessages([
      trigger({
        id: 't1',
        type: 'message',
        timestamp: 1234567890,
        payload: { kind: 'user_message', content: 'hi' },
      }),
    ]);
    expect(msgs[0]?.timestamp).toBe(1234567890);
    expect((msgs[0] as { metadata?: Record<string, unknown> }).metadata?.source).toBeUndefined();
  });

  it('不把 system_note 伪装成真人 source', () => {
    const msgs = compileMessages([
      trigger({ id: 't1', payload: { kind: 'system_note', content: 'x' } }),
    ]);
    expect((msgs[0] as { source?: unknown }).source).toBeUndefined();
  });
});

// ── CoalesceBuffer ──

describe('CoalesceBuffer', () => {
  it('同 key 窗口合并为一次 flush，并回传 DispatchResult', async () => {
    const buf = new CoalesceBuffer({ defaultWindowMs: 30 });
    const flushed: Trigger[][] = [];
    const r1 = buf.push({
      agentId: 'a',
      sessionId: 's',
      trigger: trigger({ id: 't1', coalesceKey: 'k' }),
      onFlush: (ts) => {
        flushed.push(ts);
        return Promise.resolve({
          status: 'ran',
          requestId: 'r1',
          agentId: 'a',
          sessionId: 's',
        });
      },
    });
    const r2 = buf.push({
      agentId: 'a',
      sessionId: 's',
      trigger: trigger({ id: 't2', coalesceKey: 'k' }),
      onFlush: () => {
        throw new Error('should merge');
      },
    });
    expect(r1.kind).toBe('created');
    expect(r2.kind).toBe('merged');
    const d1 = r1.kind === 'created' ? await r1.done : null;
    const d2 = r2.kind === 'merged' ? await r2.done : null;
    expect(d1?.status).toBe('ran');
    expect(d2?.status).toBe('ran');
    expect(flushed[0]?.map((t) => t.id)).toEqual(['t1', 't2']);
    buf.stop();
  });

  it('合批 flush 返回 aborted 时 waiters 收到 skipped(aborted)', async () => {
    const buf = new CoalesceBuffer({ defaultWindowMs: 20 });
    const r = buf.push({
      agentId: 'a',
      sessionId: 's',
      trigger: trigger({ id: 't1', coalesceKey: 'k' }),
      onFlush: () => Promise.resolve({ status: 'skipped', reason: 'aborted' }),
    });
    expect(r.kind).toBe('created');
    if (r.kind === 'created') {
      const done = await r.done;
      expect(done).toEqual({ status: 'skipped', reason: 'aborted' });
    }
    buf.stop();
  });

  it('不同 agent 不合批', async () => {
    const buf = new CoalesceBuffer({ defaultWindowMs: 20 });
    let n = 0;
    const p: Array<Promise<unknown>> = [];
    for (const [aid, tid] of [
      ['a1', 't1'],
      ['a2', 't2'],
    ] as const) {
      const r = buf.push({
        agentId: aid,
        sessionId: 's',
        trigger: trigger({ id: tid, coalesceKey: 'k' }),
        onFlush: () => {
          n++;
          return Promise.resolve({
            status: 'ran' as const,
            requestId: tid,
            agentId: aid,
            sessionId: 's',
          });
        },
      });
      if (r.kind === 'created' || r.kind === 'merged') p.push(r.done);
    }
    await Promise.all(p);
    expect(n).toBe(2);
    buf.stop();
  });

  it('无 coalesceKey → no_key', () => {
    const buf = new CoalesceBuffer();
    const r = buf.push({
      agentId: 'a',
      sessionId: 's',
      trigger: trigger({ id: 't1' }),
      onFlush: () =>
        Promise.resolve({ status: 'ran', requestId: 'x', agentId: 'a', sessionId: 's' }),
    });
    expect(r.kind).toBe('no_key');
  });
});

// ── AgentRuntime ──

describe('AgentRuntime', () => {
  it('未 start 时 dispatch → runtime_stopped', async () => {
    const runtime = new AgentRuntime();
    runtime.registerAgent(agent('a1', mockDispatcher()));
    const r = await runtime.dispatch(trigger({ id: 't1', agentId: 'a1' }));
    expect(r).toEqual({ status: 'skipped', reason: 'runtime_stopped' });
  });

  it('无匹配 agent → no_agent', async () => {
    const runtime = new AgentRuntime();
    await runtime.start();
    const r = await runtime.dispatch(trigger({ id: 't1', agentId: 'ghost' }));
    expect(r).toEqual({ status: 'skipped', reason: 'no_agent' });
    await runtime.stop();
  });

  it('dispatch 跑通 mock dispatcher', async () => {
    const d = mockDispatcher();
    const runtime = new AgentRuntime();
    runtime.registerAgent(agent('a1', d, () => 'a1:custom'));
    await runtime.start();
    const r = await runtime.dispatch(
      trigger({ id: 't1', agentId: 'a1', payload: { kind: 'user_message', content: 'hi' } }),
    );
    expect(r.status).toBe('ran');
    if (r.status === 'ran') {
      expect(r.agentId).toBe('a1');
      expect(r.sessionId).toBe('a1:custom');
    }
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]?.messages[0]?.content).toBe('hi');
    await runtime.stop();
  });

  it('同 session 串行：两次 dispatch 均完成', async () => {
    const d: RunDispatcher = {
      async *execute() {
        await new Promise((r) => setTimeout(r, 40));
        yield { type: 'engine.end', timestamp: Date.now() } as AgentEvent;
      },
    };
    const runtime = new AgentRuntime();
    runtime.registerAgent(agent('a1', d));
    await runtime.start();
    const [r1, r2] = await Promise.all([
      runtime.dispatch(trigger({ id: 't1', agentId: 'a1', sessionId: 's' })),
      runtime.dispatch(trigger({ id: 't2', agentId: 'a1', sessionId: 's' })),
    ]);
    expect(r1.status).toBe('ran');
    expect(r2.status).toBe('ran');
    await runtime.stop();
  });

  it('dispatcher 抛错 → failed', async () => {
    const d = mockDispatcher(undefined, { throw: true });
    const runtime = new AgentRuntime();
    runtime.registerAgent(agent('a1', d));
    await runtime.start();
    const r = await runtime.dispatch(trigger({ id: 't1', agentId: 'a1' }));
    expect(r.status).toBe('failed');
    await runtime.stop();
  });

  it('emit RuntimeEvents', async () => {
    const events: string[] = [];
    const bus = new DefaultEventBus();
    bus.onAll((e) => events.push(e.type));
    const runtime = new AgentRuntime({ events: bus });
    const seen: string[] = [];
    runtime.on((e) => seen.push(e.type));
    runtime.registerAgent(agent('a1', mockDispatcher()));
    await runtime.start();
    await runtime.dispatch(trigger({ id: 't1', agentId: 'a1' }));
    expect(seen).toContain(RuntimeEvents.TRIGGER_RECEIVED);
    expect(seen).toContain(RuntimeEvents.RUN_STARTED);
    expect(seen).toContain(RuntimeEvents.RUN_ENDED);
    expect(events).toContain(RuntimeEvents.RUN_STARTED);
    await runtime.stop();
  });

  it('同 key 合批后只 execute 一次且含两条 trigger', async () => {
    const d = mockDispatcher();
    const runtime = new AgentRuntime({ defaultCoalesceMs: 25 });
    runtime.registerAgent(agent('a1', d));
    await runtime.start();
    const p1 = runtime.dispatch(
      trigger({ id: 't1', agentId: 'a1', sessionId: 's', coalesceKey: 'batch' }),
    );
    const p2 = runtime.dispatch(
      trigger({ id: 't2', agentId: 'a1', sessionId: 's', coalesceKey: 'batch' }),
    );
    const results = await Promise.all([p1, p2]);
    expect(results.every((r: DispatchResult) => r.status === 'ran')).toBe(true);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]?.triggers).toHaveLength(2);
    await runtime.stop();
  });

  it('abort 中止 Run', async () => {
    let aborted = false;
    const d: RunDispatcher = {
      async *execute(_req, signal) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 500);
          signal?.addEventListener('abort', () => {
            aborted = true;
            clearTimeout(t);
            resolve();
          });
        });
        yield { type: 'engine.end', timestamp: Date.now() } as AgentEvent;
      },
    };
    const runtime = new AgentRuntime();
    runtime.registerAgent(agent('a1', d));
    await runtime.start();
    const p = runtime.dispatch(trigger({ id: 't1', agentId: 'a1', sessionId: 's1' }));
    setTimeout(() => runtime.abort('a1', 's1'), 20);
    const r = await p;
    expect(aborted).toBe(true);
    expect(r).toEqual({ status: 'skipped', reason: 'aborted' });
    await runtime.stop();
  });

  it('同 session 并发时 abort 能杀掉全部活跃 Run', async () => {
    const abortedIds: string[] = [];
    const d: RunDispatcher = {
      async *execute(req, signal) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 400);
          signal?.addEventListener('abort', () => {
            abortedIds.push(req.requestId);
            clearTimeout(t);
            resolve();
          });
        });
        yield { type: 'engine.end', timestamp: Date.now() } as AgentEvent;
      },
    };
    const runtime = new AgentRuntime();
    runtime.registerAgent(agent('a1', d));
    await runtime.start();
    const p1 = runtime.dispatch(trigger({ id: 't1', agentId: 'a1', sessionId: 's' }));
    const p2 = runtime.dispatch(trigger({ id: 't2', agentId: 'a1', sessionId: 's' }));
    await new Promise((r) => setTimeout(r, 30));
    runtime.abort('a1', 's');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(abortedIds).toHaveLength(2);
    expect(r1).toEqual({ status: 'skipped', reason: 'aborted' });
    expect(r2).toEqual({ status: 'skipped', reason: 'aborted' });
    await runtime.stop();
  });

  it('source emit 非阻塞：start 后 emit 不 await dispatch', async () => {
    const d = mockDispatcher(undefined, { delayMs: 50 });
    const runtime = new AgentRuntime();
    runtime.registerAgent(agent('a1', d));
    let emitCount = 0;
    const source: TriggerSource = {
      id: 'src1',
      type: 'schedule',
      async start(emit) {
        emit(trigger({ id: 's1', agentId: 'a1' }));
        emitCount++;
      },
      async stop() {},
    };
    runtime.addSource(source);
    await runtime.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(emitCount).toBe(1);
    expect(d.calls.length).toBeGreaterThanOrEqual(1);
    await runtime.stop();
  });

  it('fan-out 串行到多个 agent', async () => {
    const d1 = mockDispatcher();
    const d2 = mockDispatcher();
    const runtime = new AgentRuntime();
    runtime.registerAgent(agent('a1', d1));
    runtime.registerAgent(agent('a2', d2));
    await runtime.start();
    await runtime.dispatch(trigger({ id: 't1', toAgents: ['a1', 'a2'] }));
    expect(d1.calls).toHaveLength(1);
    expect(d2.calls).toHaveLength(1);
    await runtime.stop();
  });

  it('fan-out 部分失败 → failed', async () => {
    const ok = mockDispatcher();
    const bad = mockDispatcher(undefined, { throw: true });
    const runtime = new AgentRuntime();
    runtime.registerAgent(agent('a1', ok));
    runtime.registerAgent(agent('a2', bad));
    await runtime.start();
    const r = await runtime.dispatch(trigger({ id: 't1', toAgents: ['a1', 'a2'] }));
    expect(r.status).toBe('failed');
    if (r.status === 'failed' && 'results' in r) {
      expect(r.results).toHaveLength(2);
    }
    await runtime.stop();
  });

  it('fan-out ran + aborted 聚合：ran 且带 aborted 明细', async () => {
    const ok = mockDispatcher();
    const abortable: RunDispatcher = {
      async *execute(_req, signal) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 300);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        });
        yield { type: 'engine.end', timestamp: Date.now() } as AgentEvent;
      },
    };
    const runtime = new AgentRuntime();
    runtime.registerAgent(agent('a1', ok));
    runtime.registerAgent(agent('a2', abortable));
    await runtime.start();
    const p = runtime.dispatch(trigger({ id: 't1', toAgents: ['a1', 'a2'], sessionId: 's' }));
    setTimeout(() => runtime.abort('a2', 's'), 20);
    const r = await p;
    expect(r.status).toBe('ran');
    if (r.status === 'ran' && 'results' in r) {
      const byAgent = Object.fromEntries(r.results.map((x) => [x.agentId, x.result.status]));
      expect(byAgent.a1).toBe('ran');
      expect(byAgent.a2).toBe('skipped');
    }
    await runtime.stop();
  });

  it('dispatchMany 串行返回多条结果', async () => {
    const d = mockDispatcher();
    const runtime = new AgentRuntime();
    runtime.registerAgent(agent('a1', d));
    await runtime.start();
    const results = await runtime.dispatchMany([
      trigger({ id: 't1', agentId: 'a1' }),
      trigger({ id: 't2', agentId: 'a1' }),
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'ran')).toBe(true);
    expect(d.calls).toHaveLength(2);
    await runtime.stop();
  });

  it('on(type, listener) 按类型过滤', async () => {
    const runtime = new AgentRuntime();
    runtime.registerAgent(agent('a1', mockDispatcher()));
    const started: string[] = [];
    runtime.on(RuntimeEvents.RUN_STARTED, (e) => started.push(e.type));
    await runtime.start();
    await runtime.dispatch(trigger({ id: 't1', agentId: 'a1' }));
    expect(started).toEqual([RuntimeEvents.RUN_STARTED]);
    await runtime.stop();
  });

  it('合批路径 emit RUN_SCHEDULED', async () => {
    const runtime = new AgentRuntime({ defaultCoalesceMs: 20 });
    runtime.registerAgent(agent('a1', mockDispatcher()));
    const types: string[] = [];
    runtime.on((e) => types.push(e.type));
    await runtime.start();
    await runtime.dispatch(
      trigger({ id: 't1', agentId: 'a1', sessionId: 's', coalesceKey: 'k' }),
    );
    expect(types).toContain(RuntimeEvents.RUN_SCHEDULED);
    await runtime.stop();
  });
});
