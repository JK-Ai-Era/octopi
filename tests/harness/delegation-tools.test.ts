/**
 * P2 测试 — 子 Run 执行端口（D7/D8）与 delegate_* 工具
 *
 * 覆盖 `arch/delegation.md` P2：
 * - `RunnerChildRunPort`：独立 child session + `spawnBy` 关联（D7）
 * - 走 `runner.handle()` 而非写 `agent.context`（D8，修 I1 违规）
 * - usage 累加归集（决策 C2）
 * - 4 个工具：非阻塞 dispatch / list / get / cancel + 归属校验
 */

import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { TokenUsage } from '@octopi-agent/core/types/turn.js';

import {
  RunnerChildRunPort,
  createChildRunExecutor,
  buildChildSystemPrompt,
  DEFAULT_DELEGATION_DIRECTIVE,
} from '@octopi-agent/engine/harness/collaboration/delegation/child-run.js';
import {
  DelegationStore,
} from '@octopi-agent/engine/harness/collaboration/delegation/store.js';
import {
  DefaultAgentRegistry,
} from '@octopi-agent/engine/harness/collaboration/delegation/registry.js';
import {
  InProcessTransport,
} from '@octopi-agent/engine/harness/collaboration/delegation/transport.js';
import {
  DelegateService,
} from '@octopi-agent/engine/harness/collaboration/delegation/service.js';
import {
  DELEGATION_SCHEMA_VERSION,
} from '@octopi-agent/engine/harness/collaboration/delegation/types.js';
import {
  createDelegationTools,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/delegation.js';

// ── 测试替身 ──

/** 内存 SessionStore */
function makeMemoryStore() {
  const data = new Map<string, SessionData>();
  return {
    data,
    async load(id: string) { return data.get(id) ?? null; },
    async save(id: string, session: SessionData) { data.set(id, session); },
  };
}

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return {
    outputTokens: 0,
    inputUncachedTokens: 0,
    inputCachedTokens: 0,
    inputCacheWriteTokens: 0,
    cacheAware: false,
    ...partial,
  };
}

/** 造一个假 runner：按脚本 yield 事件，并记录收到的 runConfig */
function makeFakeRunner(script: AgentEvent[], seen: { config?: unknown } = {}) {
  return {
    async *handle(
      _sessionId: string,
      _input: unknown,
      runConfig: unknown,
      _signal?: AbortSignal,
    ): AsyncGenerator<AgentEvent> {
      seen.config = runConfig;
      for (const e of script) yield e;
    },
  };
}

const turnEnd = (content: string, u?: TokenUsage): AgentEvent => ({
  type: 'turn.end',
  timestamp: Date.now(),
  agentId: 'child',
  sessionId: 's',
  data: { content, usage: u },
} as never);

// ── RunnerChildRunPort（D7/D8） ──

describe('RunnerChildRunPort', () => {
  it('creates an independent child session carrying spawnBy (D7)', async () => {
    const store = makeMemoryStore();
    const port = new RunnerChildRunPort({
      resolve: () => ({ runner: makeFakeRunner([turnEnd('ok')]), store }),
    });

    await port.run({
      delegationId: 'del-1',
      childSessionId: 'cs-test-1',
      childRunId: 'run-test-1',
      childAgentId: 'worker',
      task: 'research',
      input: 'raw',
      context: 'clean',
      spawnBy: {
        delegationId: 'del-1',
        childSessionId: 'cs-test-1',
        childRunId: 'run-test-1',
        parentAgentId: 'main',
        parentSessionId: 's-parent',
        parentRunId: 'r-1',
      },
      systemPrompt: 'persona',
    });

    expect(store.data.size).toBe(1);
    const [id, session] = [...store.data.entries()][0];
    expect(id).not.toBe('s-parent');
    expect(session.spawnBy).toEqual({
      delegationId: 'del-1',
      childSessionId: 'cs-test-1',
      childRunId: 'run-test-1',
      parentAgentId: 'main',
      parentSessionId: 's-parent',
      parentRunId: 'r-1',
    });
    expect(session.agentId).toBe('worker');
  });

  it('runs through runner.handle() and never mutates a shared agent context (D8)', async () => {
    const seen: { config?: unknown } = {};
    const store = makeMemoryStore();
    const port = new RunnerChildRunPort({
      resolve: () => ({ runner: makeFakeRunner([turnEnd('final answer')], seen), store }),
    });

    const out = await port.run({
      delegationId: 'del-2',
      childSessionId: 'cs-test-2',
      childRunId: 'run-test-2',
      childAgentId: 'worker',
      task: 't',
      input: 'i',
      context: 'clean',
      spawnBy: { delegationId: 'del-2', parentAgentId: 'main', parentSessionId: 's', parentRunId: 'r' },
      systemPrompt: 'persona + directive',
    });

    expect(out.output).toBe('final answer');
    expect(seen.config).toMatchObject({
      agentId: 'worker',
      systemPrompt: 'persona + directive',
    });
  });

  it('accumulates usage across turns (decision C2)', async () => {
    const store = makeMemoryStore();
    const port = new RunnerChildRunPort({
      resolve: () => ({
        runner: makeFakeRunner([
          turnEnd('a', usage({ outputTokens: 10, inputUncachedTokens: 100, cacheAware: true })),
          turnEnd('b', usage({ outputTokens: 5, inputCachedTokens: 50, cacheAware: true })),
        ]), store }),
    });

    const out = await port.run({
      delegationId: 'del-3',
      childSessionId: 'cs-test-3',
      childRunId: 'run-test-3',
      childAgentId: 'worker',
      task: 't',
      input: 'i',
      context: 'clean',
      spawnBy: { delegationId: 'del-3', parentAgentId: 'main', parentSessionId: 's', parentRunId: 'r' },
      systemPrompt: 'p',
    });

    expect(out.usage?.outputTokens).toBe(15);
    expect(out.usage?.inputUncachedTokens).toBe(100);
    expect(out.usage?.inputCachedTokens).toBe(50);
    expect(out.usage?.cacheAware).toBe(true);
    expect(out.output).toBe('b');
  });

  it('captures engine.error as the output error', async () => {
    const store = makeMemoryStore();
    const port = new RunnerChildRunPort({
      resolve: () => ({
        runner: makeFakeRunner([
          { type: 'engine.error', timestamp: Date.now(), agentId: 'w', sessionId: 's', data: { error: 'boom' } } as never,
        ]), store }),
    });

    const out = await port.run({
      delegationId: 'del-4',
      childSessionId: 'cs-test-4',
      childRunId: 'run-test-4',
      childAgentId: 'worker',
      task: 't',
      input: 'i',
      context: 'clean',
      spawnBy: { delegationId: 'del-4', parentAgentId: 'main', parentSessionId: 's', parentRunId: 'r' },
      systemPrompt: 'p',
    });

    expect(out.error).toBe('boom');
    expect(out.output).toBeUndefined();
  });

  it('throws when the target agent is not runnable', async () => {
    const port = new RunnerChildRunPort({
      resolve: () => undefined,
    });

    await expect(port.run({
      delegationId: 'del-5',
      childSessionId: 'cs-test-5',
      childRunId: 'run-test-5',
      childAgentId: 'ghost',
      task: 't',
      input: 'i',
      context: 'clean',
      spawnBy: { delegationId: 'del-5', parentAgentId: 'main', parentSessionId: 's', parentRunId: 'r' },
      systemPrompt: 'p',
    })).rejects.toThrow(/not runnable/);
  });

  it('fork mode prefixes the parent history (§9.4)', async () => {
    const seen: { input?: unknown } = {};
    const store = makeMemoryStore();
    const fake = {
      async *handle(_s: string, input: unknown, _c: unknown, _sig?: AbortSignal) {
        seen.input = input;
        yield turnEnd('ok');
      },
    };
    const port = new RunnerChildRunPort({ resolve: () => ({ runner: fake, store }) });

    await port.run({
      delegationId: 'del-6',
      childSessionId: 'cs-test-6',
      childRunId: 'run-test-6',
      childAgentId: 'worker',
      task: 'task-text',
      input: 'input-text',
      context: 'fork',
      parentMessages: [{ role: 'user', content: 'prior context' }],
      spawnBy: { delegationId: 'del-6', parentAgentId: 'main', parentSessionId: 's', parentRunId: 'r' },
      systemPrompt: 'p',
    });

    const content = (seen.input as { content: string }).content;
    expect(content).toContain('Context Fork');
    expect(content).toContain('prior context');
    expect(content).toContain('task-text');
  });
});

// ── systemPrompt 构造（§9.4） ──

describe('buildChildSystemPrompt', () => {
  it('composes persona + directive + parent marker', () => {
    const prompt = buildChildSystemPrompt({ persona: 'You are a researcher.' }, 'main');
    expect(prompt).toContain('You are a researcher.');
    expect(prompt).toContain(DEFAULT_DELEGATION_DIRECTIVE);
    expect(prompt).toContain('Delegating parent: main');
  });

  it('accepts a custom directive', () => {
    const prompt = buildChildSystemPrompt(
      { persona: 'p', directive: 'custom directive' },
      'main',
    );
    expect(prompt).toContain('custom directive');
    expect(prompt).not.toContain(DEFAULT_DELEGATION_DIRECTIVE);
  });
});

// ── createChildRunExecutor 胶水 ──

describe('createChildRunExecutor', () => {
  it('maps DelegateRequest to a child run and back to DelegateResult', async () => {
    const store = makeMemoryStore();
    const port = new RunnerChildRunPort({
      resolve: () => ({ runner: makeFakeRunner([turnEnd('answer')]), store }),
    });
    const exec = createChildRunExecutor(port, { persona: 'researcher' });

    const result = await exec({
      delegationId: 'del-7',
      childSessionId: 'cs-test-7',
      childRunId: 'run-test-7',
      from: { agentId: 'main', sessionId: 's', runId: 'r' },
      to: { agentId: 'worker' },
      task: 't',
      input: 'i',
      context: 'clean',
      schemaVersion: DELEGATION_SCHEMA_VERSION,
    });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('answer');
    expect(result.delegationId).toBe('del-7');
    expect(result.schemaVersion).toBe(DELEGATION_SCHEMA_VERSION);
  });

  it('fails cleanly when the request has no resolved agentId', async () => {
    const exec = createChildRunExecutor(
      new RunnerChildRunPort({ resolve: () => undefined }),
      { persona: 'p' },
    );
    const result = await exec({
      delegationId: 'del-8',
      childSessionId: 'cs-test-8',
      childRunId: 'run-test-8',
      from: { agentId: 'main', sessionId: 's', runId: 'r' },
      to: { trait: 'research' },
      task: 't',
      input: 'i',
      context: 'clean',
      schemaVersion: DELEGATION_SCHEMA_VERSION,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/unresolved target agentId/);
  });

  it('propagates a child failure as status=failed', async () => {
    const port = new RunnerChildRunPort({
      resolve: () => ({
        runner: makeFakeRunner([
          { type: 'engine.error', timestamp: Date.now(), agentId: 'w', sessionId: 's', data: { error: 'kaboom' } } as never,
        ]), store: makeMemoryStore() }),
    });
    const exec = createChildRunExecutor(port, { persona: 'p' });
    const result = await exec({
      delegationId: 'del-9',
      childSessionId: 'cs-test-9',
      childRunId: 'run-test-9',
      from: { agentId: 'main', sessionId: 's', runId: 'r' },
      to: { agentId: 'worker' },
      task: 't',
      input: 'i',
      context: 'clean',
      schemaVersion: DELEGATION_SCHEMA_VERSION,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('kaboom');
  });
});

// ── delegate_* 工具 ──

function makeToolHarness() {
  const registry = new DefaultAgentRegistry();
  registry.register({
    id: 'worker',
    name: 'worker',
    traits: ['research'],
    status: 'idle',
    delegation: { callable: true, canDelegate: false, maxDepth: 1 },
  });
  const store = new DelegationStore();
  const service = new DelegateService(
    store,
    registry,
    new InProcessTransport(async (req) => ({
      delegationId: req.delegationId,
      status: 'completed',
      output: 'child says hi',
      schemaVersion: DELEGATION_SCHEMA_VERSION,
    })),
    {},
  );
  const tools = createDelegationTools(service);
  const byName = Object.fromEntries(tools.map((t) => [t.definition.name, t]));
  return { service, store, byName };
}

const CTX = {
  agentId: 'main',
  sessionId: 's-parent',
  runId: 'r-1',
  messages: [],
} as never;

describe('delegate_* tools', () => {
  it('registers exactly the four tools', () => {
    const { byName } = makeToolHarness();
    expect(Object.keys(byName).sort()).toEqual(
      ['delegate_cancel', 'delegate_dispatch', 'delegate_get', 'delegate_list'],
    );
  });

  it('dispatch requires exactly one of agent / trait', async () => {
    const { byName } = makeToolHarness();
    const both = await byName.delegate_dispatch.handler(
      { agent: 'worker', trait: 'research', task: 't', input: 'i' },
      CTX,
    );
    expect(both).toMatchObject({ ok: false });

    const neither = await byName.delegate_dispatch.handler({ task: 't', input: 'i' }, CTX);
    expect(neither).toMatchObject({ ok: false });
  });

  it('dispatch is non-blocking and returns a delegation id', async () => {
    const { byName } = makeToolHarness();
    const result = await byName.delegate_dispatch.handler(
      { agent: 'worker', task: 't', input: 'i' },
      CTX,
    ) as { ok: boolean; delegation_id: string; status: string };

    expect(result.ok).toBe(true);
    expect(result.delegation_id).toMatch(/^del-/);
    expect(['queued', 'running']).toContain(result.status);
  });

  it('reports a resolution failure without throwing', async () => {
    const { byName } = makeToolHarness();
    const result = await byName.delegate_dispatch.handler(
      { agent: 'ghost', task: 't', input: 'i' },
      CTX,
    ) as { ok: boolean; reason?: string };

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('list shows delegations of the calling session only', async () => {
    const { byName } = makeToolHarness();
    await byName.delegate_dispatch.handler({ agent: 'worker', task: 'a', input: 'i' }, CTX);

    const listed = await byName.delegate_list.handler({}, CTX) as { total: number };
    expect(listed.total).toBe(1);

    const otherSession = await byName.delegate_list.handler({}, {
      ...CTX, sessionId: 's-other',
    } as never) as { total: number };
    expect(otherSession.total).toBe(0);
  });

  it('get enforces ownership', async () => {
    const { byName } = makeToolHarness();
    const dispatched = await byName.delegate_dispatch.handler(
      { agent: 'worker', task: 't', input: 'i' },
      CTX,
    ) as { delegation_id: string };

    const mine = await byName.delegate_get.handler(
      { delegation_id: dispatched.delegation_id },
      CTX,
    ) as { ok: boolean };
    expect(mine.ok).toBe(true);

    const theirs = await byName.delegate_get.handler(
      { delegation_id: dispatched.delegation_id },
      { ...CTX, sessionId: 's-intruder' } as never,
    ) as { ok: boolean; error: string };
    expect(theirs.ok).toBe(false);
    expect(theirs.error).toMatch(/not owned/);
  });

  it('cancel enforces ownership and rejects unknown ids', async () => {
    const { byName } = makeToolHarness();
    const missing = await byName.delegate_cancel.handler({ delegation_id: 'del-nope' }, CTX) as { ok: boolean };
    expect(missing.ok).toBe(false);

    const dispatched = await byName.delegate_dispatch.handler(
      { agent: 'worker', task: 't', input: 'i' },
      CTX,
    ) as { delegation_id: string };

    const intruder = await byName.delegate_cancel.handler(
      { delegation_id: dispatched.delegation_id },
      { ...CTX, sessionId: 's-intruder' } as never,
    ) as { ok: boolean };
    expect(intruder.ok).toBe(false);
  });

  it('get reflects the finished result once the child run settles', async () => {
    const { byName } = makeToolHarness();
    const dispatched = await byName.delegate_dispatch.handler(
      { agent: 'worker', task: 't', input: 'i' },
      CTX,
    ) as { delegation_id: string };

    await vi.waitFor(async () => {
      const got = await byName.delegate_get.handler(
        { delegation_id: dispatched.delegation_id },
        CTX,
      ) as { status: string; output?: string };
      expect(got.status).toBe('completed');
      expect(got.output).toBe('child says hi');
    });
  });

  it('get marks a terminal delegation surfaced (§7.3 hint de-dup)', async () => {
    const { byName, store, service } = makeToolHarness();
    const dispatched = await byName.delegate_dispatch.handler(
      { agent: 'worker', task: 't', input: 'i' },
      CTX,
    ) as { delegation_id: string };

    await vi.waitFor(() => expect(store.get(dispatched.delegation_id)?.status).toBe('completed'));
    expect(store.get(dispatched.delegation_id)?.notified).toBe(false);

    const got = await byName.delegate_get.handler(
      { delegation_id: dispatched.delegation_id },
      CTX,
    ) as { ok: boolean; notified: boolean };
    expect(got.ok).toBe(true);
    expect(got.notified).toBe(true);
    expect(store.get(dispatched.delegation_id)?.notified).toBe(true);
    expect(service.renderStatusHint('s-parent')).toBe('');
  });

  it('list stays read-only: the hint survives until delegate_get surfaces the result', async () => {
    const { byName, store, service } = makeToolHarness();
    await byName.delegate_dispatch.handler({ agent: 'worker', task: 't', input: 'i' }, CTX);
    await vi.waitFor(() => expect(store.list()[0]?.status).toBe('completed'));

    const listed = await byName.delegate_list.handler({}, CTX) as {
      total: number;
      delegations: Array<{ notified: boolean }>;
    };
    expect(listed.total).toBe(1);
    // 列表是只读概览：不置位（结果可能被截断，只有 get 取回全文才算送达）
    expect(listed.delegations[0].notified).toBe(false);
    expect(store.list()[0].notified).toBe(false);
    expect(service.renderStatusHint('s-parent')).toContain('1 completed');

    await byName.delegate_get.handler({ delegation_id: store.list()[0].id }, CTX);
    expect(store.list()[0].notified).toBe(true);
  });

  it('depth gate applies through resolveParentDepth', async () => {
    const registry = new DefaultAgentRegistry();
    registry.register({
      id: 'worker',
      name: 'worker',
      traits: [],
      status: 'idle',
      delegation: { callable: true, canDelegate: false, maxDepth: 1 },
    });
    const store = new DelegationStore();
    const service = new DelegateService(
      store,
      registry,
      new InProcessTransport(async (req) => ({
        delegationId: req.delegationId,
        status: 'completed',
        schemaVersion: DELEGATION_SCHEMA_VERSION,
      })),
      { resolveParentDepth: () => 1 },
    );
    const byName = Object.fromEntries(
      createDelegationTools(service).map((t) => [t.definition.name, t]),
    );

    const result = await byName.delegate_dispatch.handler(
      { agent: 'worker', task: 't', input: 'i' },
      CTX,
    ) as { ok: boolean; reason?: string };

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('depth_exceeded');
  });
});
