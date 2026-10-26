/**
 * ops P5 kill switch 测试：宿主侧急停哨兵——run 准入拒 + 逐工具闸拒，不依赖 LLM/agent。
 * 规格：arch/ops-privileged-mode.md §5 P5。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkKillSwitch,
  defaultKillSwitchPath,
} from '@octopi-agent/engine/harness/extension/execution-environment/kill-switch.js';
import { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { Agent } from '@octopi-agent/engine/harness/run/agent/index.js';
import type { Message } from '@octopi-agent/core/types.js';

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

function scriptedAgent(): Agent {
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
      opts?.context?.messages.push({ role: 'assistant', content: 'ans', timestamp: Date.now() });
      yield { type: 'turn_end', timestamp: Date.now(), hasToolCalls: false, phase: 'final', usage: undefined } as never;
      yield { type: 'agent_end', reason: 'completed', timestamp: Date.now() } as never;
    },
  } as unknown as Agent;
}

describe('kill switch：宿主侧急停哨兵（P5）', () => {
  let home: string;

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('checkKillSwitch：哨兵缺失 = 未触发；存在 = engaged（每次实查，revive 立即生效）', async () => {
    home = await mkdtemp(join(tmpdir(), 'octopi-kill-'));
    const sentinel = join(home, 'KILL');
    expect(checkKillSwitch([sentinel])).toEqual({ engaged: false });
    expect(checkKillSwitch(undefined)).toEqual({ engaged: false });
    expect(checkKillSwitch([])).toEqual({ engaged: false });

    await writeFile(sentinel, 'stop\n');
    expect(checkKillSwitch([sentinel])).toMatchObject({ engaged: true, path: sentinel });
    await rm(sentinel);
    // 不缓存：删除即恢复
    expect(checkKillSwitch([sentinel])).toEqual({ engaged: false });
  });

  it('defaultKillSwitchPath 布局：<OCTOPI_HOME>/agents/<id>/KILL', () => {
    expect(defaultKillSwitchPath('a1')).toMatch(/agents[/\\]a1[/\\]KILL$/);
  });

  it('run 准入：哨兵存在 → 拒 run（kill_switch_active）+ ops.kill_switch.tripped 落账', async () => {
    home = await mkdtemp(join(tmpdir(), 'octopi-kill-run-'));
    const sentinel = join(home, 'KILL');
    await writeFile(sentinel, 'stop\n');
    const store = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
    await store.save('s1', emptySession('s1'));
    const journalPath = join(home, 'ops.jsonl');
    const runner = new SessionAwareRunner(scriptedAgent(), {} as never, store, {
      opsAuditPath: journalPath,
      killSwitchPath: sentinel,
    });

    await expect(
      (async () => {
        for await (const _ev of runner.handle(
          's1',
          { role: 'user', content: 'hi', timestamp: Date.now() } as Message,
          { agentId: 'a1' } as never,
        )) {
          // drain
        }
      })(),
    ).rejects.toThrow(/kill_switch_active/);

    const body = await readFile(journalPath, 'utf8');
    expect(body).toContain('ops.kill_switch.tripped');
    expect(body).toContain('refuse_run');

    // revive 后同一 runner 恢复执行（哨兵每次实查）
    await rm(sentinel);
    const events: Array<{ type: string }> = [];
    for await (const ev of runner.handle(
      's1',
      { role: 'user', content: 'hi again', timestamp: Date.now() } as Message,
      { agentId: 'a1' } as never,
    )) {
      events.push(ev as { type: string });
    }
    // 恢复判据：run 不再被拒且事件正常产出（具体事件名属适配层词表，不在此钉）
    expect(events.length).toBeGreaterThan(0);
  });

  it('逐工具闸：run 进行中触发哨兵 → beforeToolCall 全拒（agent 无法绕过）', async () => {
    home = await mkdtemp(join(tmpdir(), 'octopi-kill-tool-'));
    const sentinel = join(home, 'KILL');
    await writeFile(sentinel, 'stop\n');

    const { Agent } = await import('@octopi-agent/engine/harness/run/agent/agent.js');
    const { runAgentWithReliability } = await import(
      '@octopi-agent/engine/harness/run/reliability/run-agent.js'
    );
    const { withRunScope } = await import('@octopi-agent/engine/harness/run/run-scope.js');

    let executed = 0;
    const agent = new Agent({
      model: {
        name: 'test',
        defaultModel: 'test',
        getModelInfo: () => null,
        async chat() {
          return {
            content: '',
            toolCalls: [{ id: 'c1', name: 'shell', arguments: {} }],
            usage: { promptTokens: 1, completionTokens: 1 },
            model: 'test',
            finishReason: 'tool_calls',
          };
        },
        async isAvailable() {
          return true;
        },
      } as never,
      systemPrompt: 'x',
      tools: [
        {
          name: 'shell',
          description: 'run',
          parameters: { type: 'object' as const, properties: {} },
          execute: async () => {
            executed += 1;
            return { toolCallId: 'c1', name: 'shell', content: 'ran' };
          },
        },
      ],
    });
    agent.context.messages = [{ role: 'user', content: 'go', timestamp: Date.now() }];

    const harness = {
      config: {
        planningRetry: { maxAttempts: 0, steerInstruction: '' },
        emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
        noopThreshold: 99,
        loopDetection: { enabled: false },
      },
    };

    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const gen = runAgentWithReliability(agent.context, { model: agent.model }, harness as never);
    for await (const e of withRunScope(
      {
        sessionId: 's-kill',
        agentId: 'a1',
        toolRuntime: {
          sessionId: 's-kill',
          agentId: 'a1',
          messages: [],
          fileEffects: {
            writeFile: async () => {},
            appendFile: async () => {},
            recordDelete: async () => {},
            recordCreate: async () => {},
            recordRename: async () => {},
            recordOverwrite: async () => {},
            noteNotReversed: async () => {},
          },
          memoryEffects: {
            recordInsert: async () => {},
            recordUpdate: async () => {},
            recordDelete: async () => {},
          },
          killSwitchPaths: [sentinel],
        } as never,
      },
      gen,
    )) {
      events.push(e as { type: string; data?: Record<string, unknown> });
    }

    expect(executed).toBe(0);
    const blocked = events.find((e) => e.type === 'security_blocked');
    expect(blocked).toBeTruthy();
    expect(String(blocked?.data?.reason ?? '')).toContain('kill_switch_active');
  });
});
