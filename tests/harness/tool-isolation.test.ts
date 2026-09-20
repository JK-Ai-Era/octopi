/**
 * 宪法 I5 — 工具效应面：toolIsolation 最小集
 *
 * 行为：
 * 1. resolveToolIsolationCwd 单元语义（none / session-subdir / session-lock）
 * 2. 双 Session session-subdir：工具 cwd 不交叉，文件落盘不交叉
 * 3. 默认 none：共享 agent.workspace（向后兼容）
 * 4. session-lock：共享路径，但 isolation 模式写入 RunScope
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  DEFAULT_TOOL_ISOLATION,
  resolveToolIsolationCwd,
} from '../../src/harness/tool-effect/isolation.js';
import { SessionAwareRunner } from '../../src/harness/runner.js';
import { withRunScope, getRunScope } from '../../src/harness/run-scope.js';
import { getRunScope as getScopeFromRunnerModule } from '../../src/harness/run-scope.js';
import type { Agent } from '../../src/harness/agent/index.js';
import type { Message } from '../../src/core/types.js';
import { InMemorySessionStore } from '../../src/integration/storage/memory.js';
import type { SessionData } from '../../src/harness/session-types.js';
import type { ToolIsolationMode } from '../../src/harness/tool-effect/isolation.js';

void getScopeFromRunnerModule;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function emptySession(id: string, agentId = 'a1'): SessionData {
  return {
    id,
    agentId,
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
  };
}

function makeMockAgent(opts?: {
  onRun?: (sessionId: string, cwd: string | undefined, isolation: string | undefined) => Promise<void> | void;
}): { agent: Agent; captured: Array<{ sessionId: string; cwd?: string; isolation?: string }> } {
  const captured: Array<{ sessionId: string; cwd?: string; isolation?: string }> = [];
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
    setOnAfterTurn: () => {},
    notifyAfterTurn: async () => {},
    run: async function* (
      _signal?: AbortSignal,
      _h?: unknown,
      runOpts?: {
        context?: { messages: Message[] };
        runScope?: {
          sessionId: string;
          agentId: string;
          toolRuntime?: { sessionId: string; agentId: string; cwd?: string; isolation?: string };
        };
      },
    ) {
      const scope = runOpts?.runScope;
      // 同步进入 ALS：与 Agent.run 生产路径一致（run 内部会 withRunScope）
      const toolRt = scope?.toolRuntime;
      const row = {
        sessionId: scope?.sessionId ?? 'unknown',
        cwd: toolRt?.cwd,
        isolation: toolRt?.isolation,
      };
      captured.push(row);
      if (opts?.onRun) {
        await opts.onRun(row.sessionId, row.cwd, row.isolation);
      }
      const ctx = runOpts?.context;
      if (ctx) {
        ctx.messages.push({ role: 'assistant', content: `ok-${row.sessionId}`, timestamp: Date.now() });
      }
      yield { type: 'turn_end', timestamp: Date.now(), usage: undefined } as never;
      yield { type: 'agent_end', reason: 'done', timestamp: Date.now() } as never;
    },
  };
  return { agent: agent as unknown as Agent, captured };
}

describe('resolveToolIsolationCwd (I5)', () => {
  it('默认模式为 none', () => {
    expect(DEFAULT_TOOL_ISOLATION).toBe('none');
  });

  it('none：cwd = baseCwd，不拼 sessionId', () => {
    const r = resolveToolIsolationCwd({ mode: 'none', sessionId: 's1', baseCwd: '/ws/agent' });
    expect(r.mode).toBe('none');
    expect(r.cwd).toBe('/ws/agent');
  });

  it('none：无 baseCwd 时 cwd 为 undefined', () => {
    const r = resolveToolIsolationCwd({ mode: 'none', sessionId: 's1', baseCwd: '  ' });
    expect(r.cwd).toBeUndefined();
  });

  it('session-subdir：cwd = resolve(join(baseCwd, safe(sessionId)))', () => {
    const r = resolveToolIsolationCwd({ mode: 'session-subdir', sessionId: 'sA', baseCwd: '/ws/agent' });
    expect(r.mode).toBe('session-subdir');
    expect(r.cwd).toBe(resolve('/ws/agent', 'sA'));
  });

  it('session-subdir：恶意 sessionId 不逃出 baseCwd', () => {
    const base = '/ws/agent';
    const resolvedBase = resolve(base);
    const prefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
    for (const evil of ['../evil', '..\\evil', 'C:\\Windows\\evil', '/etc/passwd']) {
      const r = resolveToolIsolationCwd({ mode: 'session-subdir', sessionId: evil, baseCwd: base });
      expect(r.cwd).toBeDefined();
      expect(r.cwd === resolvedBase || r.cwd!.startsWith(prefix)).toBe(true);
    }
  });

  it('session-subdir：无 baseCwd 时不发明路径', () => {
    const r = resolveToolIsolationCwd({ mode: 'session-subdir', sessionId: 'sA', baseCwd: undefined });
    expect(r.cwd).toBeUndefined();
  });

  it('session-lock：共享 baseCwd，不路径隔离', () => {
    const a = resolveToolIsolationCwd({ mode: 'session-lock', sessionId: 'sA', baseCwd: '/ws/agent' });
    const b = resolveToolIsolationCwd({ mode: 'session-lock', sessionId: 'sB', baseCwd: '/ws/agent' });
    expect(a.cwd).toBe('/ws/agent');
    expect(b.cwd).toBe('/ws/agent');
    expect(a.mode).toBe('session-lock');
  });
});

describe('SessionAwareRunner toolIsolation (I5)', () => {
  it('session-subdir：双 Session 工具 cwd 与写入路径不交叉', async () => {
    const base = mkdtempSync(join(tmpdir(), 'octopi-i5-subdir-'));
    const writeTargets: Record<string, string> = {};

    const { agent, captured } = makeMockAgent({
      onRun: (sessionId, cwd) => {
        if (!cwd) return;
        const file = join(cwd, 'out.txt');
        writeFileSync(file, `content-for-${sessionId}`, 'utf-8');
        writeTargets[sessionId] = file;
      },
    });

    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store, {
      toolIsolation: 'session-subdir',
      agentWorkspace: base,
    });

    await store.save('a1', 'sA', emptySession('sA'));
    await store.save('a1', 'sB', emptySession('sB'));

    const collect = async (sessionId: string) => {
      for await (const _ of runner.handle(
        sessionId,
        { role: 'user', content: `hi-${sessionId}`, timestamp: Date.now() },
        { systemPrompt: '', agentId: 'a1', sessionId },
      )) {
        void _;
      }
    };

    await Promise.all([collect('sA'), collect('sB')]);

    const cwdA = join(base, 'sA');
    const cwdB = join(base, 'sB');
    const rowsA = captured.filter((c) => c.sessionId === 'sA');
    const rowsB = captured.filter((c) => c.sessionId === 'sB');
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsB.length).toBeGreaterThan(0);
    for (const r of rowsA) {
      expect(r.cwd).toBe(cwdA);
      expect(r.isolation).toBe('session-subdir');
    }
    for (const r of rowsB) {
      expect(r.cwd).toBe(cwdB);
      expect(r.isolation).toBe('session-subdir');
    }

    expect(writeTargets.sA).toBe(join(cwdA, 'out.txt'));
    expect(writeTargets.sB).toBe(join(cwdB, 'out.txt'));
    expect(writeTargets.sA).not.toBe(writeTargets.sB);
    expect(existsSync(writeTargets.sA!)).toBe(true);
    expect(existsSync(writeTargets.sB!)).toBe(true);
    expect(readFileSync(writeTargets.sA!, 'utf-8')).toBe('content-for-sA');
    expect(readFileSync(writeTargets.sB!, 'utf-8')).toBe('content-for-sB');
  });

  it('默认 none：双 Session 共享 agentWorkspace（向后兼容）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'octopi-i5-none-'));
    const { agent, captured } = makeMockAgent();
    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store, {
      agentWorkspace: base,
    });

    await store.save('a1', 'sA', emptySession('sA'));
    await store.save('a1', 'sB', emptySession('sB'));

    const collect = async (sessionId: string) => {
      for await (const _ of runner.handle(
        sessionId,
        { role: 'user', content: `hi-${sessionId}`, timestamp: Date.now() },
        { systemPrompt: '', agentId: 'a1', sessionId },
      )) {
        void _;
      }
    };
    await Promise.all([collect('sA'), collect('sB')]);

    for (const r of captured) {
      expect(r.cwd).toBe(base);
      expect(r.isolation).toBe('none');
    }
  });

  it('session-lock：共享路径 + isolation 写入 RunToolRuntime', async () => {
    const base = mkdtempSync(join(tmpdir(), 'octopi-i5-lock-'));
    const { agent, captured } = makeMockAgent();
    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store, {
      toolIsolation: 'session-lock' satisfies ToolIsolationMode,
      agentWorkspace: base,
    });

    await store.save('a1', 'sA', emptySession('sA'));
    for await (const _ of runner.handle(
      'sA',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'a1', sessionId: 'sA' },
    )) {
      void _;
    }

    expect(captured.length).toBeGreaterThan(0);
    for (const r of captured) {
      expect(r.cwd).toBe(base);
      expect(r.isolation).toBe('session-lock');
    }
  });

  it('RunConfig.toolIsolation 可覆盖 Runner 配置', async () => {
    const base = mkdtempSync(join(tmpdir(), 'octopi-i5-override-'));
    const { agent, captured } = makeMockAgent();
    const store = new InMemorySessionStore();
    const runner = new SessionAwareRunner(agent, {} as never, store, {
      toolIsolation: 'none',
      agentWorkspace: base,
    });

    await store.save('a1', 'sX', emptySession('sX'));
    for await (const _ of runner.handle(
      'sX',
      { role: 'user', content: 'hi', timestamp: Date.now() },
      {
        systemPrompt: '',
        agentId: 'a1',
        sessionId: 'sX',
        toolIsolation: 'session-subdir',
      },
    )) {
      void _;
    }

    expect(captured.length).toBeGreaterThan(0);
    for (const r of captured) {
      expect(r.isolation).toBe('session-subdir');
      expect(r.cwd).toBe(join(base, 'sX'));
    }
  });
});

describe('RunScope ALS toolRuntime (I5)', () => {
  it('withRunScope 内 toolRuntime.cwd 可被工具上下文读取', async () => {
    const seen: Array<{ cwd?: string; isolation?: string }> = [];
    async function* worker() {
      await sleep(1);
      const scope = getRunScope();
      seen.push({
        cwd: scope?.toolRuntime?.cwd,
        isolation: scope?.toolRuntime?.isolation,
      });
      yield 1;
    }
    const gen = withRunScope(
      {
        sessionId: 's1',
        agentId: 'a1',
        toolRuntime: {
          sessionId: 's1',
          agentId: 'a1',
          messages: [],
          cwd: '/ws/a1/s1',
          isolation: 'session-subdir',
        },
      },
      worker(),
    );
    for await (const _ of gen) void _;
    expect(seen[0]?.cwd).toBe('/ws/a1/s1');
    expect(seen[0]?.isolation).toBe('session-subdir');
  });
});
