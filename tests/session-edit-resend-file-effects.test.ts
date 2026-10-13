/**
 * 编辑重发 × L3 文件 undo 集成
 *
 * truncateMessagesFrom 必须逆放本轮 agent 文件效应；用户手改保留。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { InMemorySessionStore } from '@octopi-agent/engine/harness/session/in-memory-store.js';
import { InMemoryMemoryStore } from '@octopi-agent/engine/harness/memory/store.js';
import {
  TurnFileUndoLog,
} from '@octopi-agent/engine/harness/extension/execution-environment/undo-log.js';
import {
  createMemoryRestorer,
  JournaledMemoryStore,
} from '@octopi-agent/engine/harness/extension/execution-environment/memory-undo.js';
import type { Message, GatewayConfig } from '@octopi-agent/core/types.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('edit-resend file effects (L3)', () => {
  let home: string;
  let prevHome: string | undefined;
  let store: InMemorySessionStore;
  let gateway: Gateway;

  beforeEach(() => {
    home = join(tmpdir(), `octopi-home-${randomUUID()}`);
    prevHome = process.env.OCTOPI_HOME;
    process.env.OCTOPI_HOME = home;
    store = new InMemorySessionStore();
    gateway = new Gateway(
      {
        agents: [{ id: 'a1', model: { provider: 'mock', model: 'm' } }],
      } as unknown as GatewayConfig,
      store,
    );
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.OCTOPI_HOME;
    else process.env.OCTOPI_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it('rejects truncate when fromIndex is not abortedTurn', async () => {
    const t = Date.now();
    const sessionId = 's-guard';
    await store.save(sessionId, {
      id: sessionId,
      agentId: 'a1',
      primaryAgentId: 'a1',
      meta: {
        id: sessionId,
        agentId: 'a1',
        channelId: 'web',
        peerId: 'p',
        status: 'idle',
        createdAt: t,
        sessionStartedAt: t,
        lastInteractionAt: t,
        updatedAt: t,
      },
      messages: [{ role: 'user', content: 'go', timestamp: t }],
      turns: [],
      metadata: {},
      tasks: [],
    });
    await expect(gateway.truncateMessagesFrom(sessionId, 0)).rejects.toThrow(/edit_resend_only_last_aborted_turn/);
  });

  it('truncate discards agent file effects and reports them', async () => {
    const t = Date.now();
    const sessionId = 's-fx';
    await mkdir(join(home, 'work'), { recursive: true });
    const p = join(home, 'work', 'doc.txt');
    await writeFile(p, 'original');

    // 模拟 abort 后残留的本轮 undo
    const log = await TurnFileUndoLog.begin({
      sessionsDir: join(home, 'sessions'),
      sessionId,
    });
    await log.writeFile(p, 'agent-draft');

    await store.save(sessionId, {
      id: sessionId,
      agentId: 'a1',
      primaryAgentId: 'a1',
      meta: {
        id: sessionId,
        agentId: 'a1',
        channelId: 'web',
        peerId: 'p',
        status: 'idle',
        createdAt: t,
        sessionStartedAt: t,
        lastInteractionAt: t,
        updatedAt: t,
      },
      messages: [
        { role: 'user', content: 'go', timestamp: t },
        { role: 'assistant', content: 'partial', timestamp: t + 1, agentId: 'a1' },
      ],
      turns: [],
      metadata: { abortedTurn: { userMessageIndex: 0, at: t + 2 } },
      tasks: [],
    });

    const result = await gateway.truncateMessagesFrom(sessionId, 0);
    expect(result.messageCount).toBe(0);
    expect(result.fileEffects.entries).toBe(1);
    expect(result.fileEffects.discarded).toEqual([{ path: p, action: 'restored' }]);
    expect(await readFile(p, 'utf8')).toBe('original');
  });

  it('truncate keeps user edits on agent-written file', async () => {
    const t = Date.now();
    const sessionId = 's-fx2';
    await mkdir(join(home, 'work'), { recursive: true });
    const p = join(home, 'work', 'keep.txt');
    await writeFile(p, 'before\n');

    const log = await TurnFileUndoLog.begin({
      sessionsDir: join(home, 'sessions'),
      sessionId,
    });
    await log.writeFile(p, 'agent\n');
    await writeFile(p, 'agent\nuser-touch\n');

    await store.save(sessionId, {
      id: sessionId,
      agentId: 'a1',
      primaryAgentId: 'a1',
      meta: {
        id: sessionId,
        agentId: 'a1',
        channelId: 'web',
        peerId: 'p',
        status: 'idle',
        createdAt: t,
        sessionStartedAt: t,
        lastInteractionAt: t,
        updatedAt: t,
      },
      messages: [
        { role: 'user', content: 'go', timestamp: t },
        { role: 'assistant', content: 'x', timestamp: t + 1, agentId: 'a1' },
      ],
      turns: [],
      metadata: { abortedTurn: { userMessageIndex: 0, at: t + 2 } },
      tasks: [],
    });

    const result = await gateway.truncateMessagesFrom(sessionId, 0);
    const text = await readFile(p, 'utf8');
    expect(text).toContain('user-touch');
    expect(text).not.toContain('agent\n');
    expect(text).toContain('before');
    expect(result.fileEffects.discarded.length).toBe(1);
    expect(await exists(join(home, 'sessions', sessionId, 'undo'))).toBe(false);
  });

  it('truncate reverses memory effects when restorer is registered', async () => {
    const t = Date.now();
    const sessionId = 's-fx3';
    const inner = new InMemoryMemoryStore();
    const undo = await TurnFileUndoLog.begin({
      sessionsDir: join(home, 'sessions'),
      sessionId,
    });
    const mem = new JournaledMemoryStore(inner, () => undo.memoryEffects);
    const memId = await mem.store({
      type: 'fact',
      content: 'from aborted turn',
      source: 'test',
      confidence: 0.8,
      importance: 0.5,
    } as never);

    // 注册 restorer（模拟 gateway 构建 agent 时）
    const anyGw = gateway as unknown as {
      memoryRestorers: Map<string, unknown>;
    };
    anyGw.memoryRestorers.set('a1', createMemoryRestorer(inner));

    await store.save(sessionId, {
      id: sessionId,
      agentId: 'a1',
      primaryAgentId: 'a1',
      meta: {
        id: sessionId,
        agentId: 'a1',
        channelId: 'web',
        peerId: 'p',
        status: 'idle',
        createdAt: t,
        sessionStartedAt: t,
        lastInteractionAt: t,
        updatedAt: t,
      },
      messages: [
        { role: 'user', content: 'go', timestamp: t },
        { role: 'assistant', content: 'x', timestamp: t + 1, agentId: 'a1' },
      ],
      turns: [],
      metadata: { abortedTurn: { userMessageIndex: 0, at: t + 2 } },
      tasks: [],
    });

    const result = await gateway.truncateMessagesFrom(sessionId, 0);
    expect(result.fileEffects.memory.entries).toBe(1);
    expect(result.fileEffects.memory.reversed[0]?.id).toBe(memId);
    expect(await inner.get(memId)).toBeNull();
  });
});
