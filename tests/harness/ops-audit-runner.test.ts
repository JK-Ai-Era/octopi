/**
 * ops P2 runner 级集成：安全配置漂移拒新 run（§8.4 拍板）+ 审计账本经 handle 落账。
 * 这层是评审 P0 的补洞——「守卫接了线且真的拒绝」必须有 runner 级断言。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/** 单 turn 脚本 agent（run 走通即可，与模型无关） */
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

describe('ops 审计 × runner 集成', () => {
  let home: string;

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('安全配置漂移 → 拒新 run + ops.config.security_changed 落账本', async () => {
    home = await mkdtemp(join(tmpdir(), 'octopi-ops-drift-'));
    const store = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
    await store.save('s1', emptySession('s1'));
    const journalPath = join(home, 'ops.jsonl');
    const runner = new SessionAwareRunner(scriptedAgent(), {} as never, store, {
      opsAuditPath: journalPath,
      securityIntegrity: {
        fingerprint: 'anchor-hash',
        recheck: () => ({ ok: false, changed: ['effectPolicy.jail'], currentFingerprint: 'new-hash' }),
      },
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
    ).rejects.toThrow(/security_config_drift/);

    const body = await readFile(journalPath, 'utf8');
    expect(body).toContain('ops.config.security_changed');
    expect(body).toContain('effectPolicy.jail');
    // §7：旧→新摘要 + 来源/署名态如实
    expect(body).toContain('anchor-hash');
    expect(body).toContain('new-hash');
    expect(body).toContain('"hostAttested":false');
  });

  it('无漂移：ops.jail.state 经 handle 落账本（授权/故障判据持久化）', async () => {
    home = await mkdtemp(join(tmpdir(), 'octopi-ops-ok-'));
    const store = new JsonlSessionStore({ sessionsDir: join(home, 'sessions') });
    await store.save('s1', emptySession('s1'));
    const journalPath = join(home, 'ops.jsonl');
    const runner = new SessionAwareRunner(scriptedAgent(), {} as never, store, {
      opsAuditPath: journalPath,
      securityIntegrity: {
        fingerprint: 'anchor-hash',
        recheck: () => ({ ok: true, changed: [], currentFingerprint: 'anchor-hash' }),
      },
    });

    for await (const _ev of runner.handle(
      's1',
      { role: 'user', content: 'hi', timestamp: Date.now() } as Message,
      { agentId: 'a1' } as never,
    )) {
      // drain
    }

    const body = await readFile(journalPath, 'utf8');
    expect(body).toContain('ops.jail.state');
    const lines = body.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });
});
