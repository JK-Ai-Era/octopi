/**
 * Turn 账本瘦身回归（性能修复：state.json 二次方膨胀）
 *
 * 1. 读取历史 state.json（turns[].input 带全量历史快照）→ 读取即剥 input
 * 2. save 写回后磁盘上不再含 turns[].input（首次 save 自然瘦身）
 * 3. 新账本字段 round-trip 保全（换新实例重读，防假绿）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import { toSessionFileName } from '@octopi-agent/core/session-filename.js';

function makeSession(overrides?: Partial<SessionData>): SessionData {
  return {
    id: 'sess-slim-1',
    agentId: 'default',
    primaryAgentId: 'default',
    meta: {
      id: 'sess-slim-1',
      agentId: 'default',
      channelId: 'web',
      peerId: 'test',
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
    ...overrides,
  };
}

describe('turn ledger slim (no full-history input snapshots)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'octopi-turn-slim-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('load strips legacy turns[].input from historical state.json', async () => {
    const store = new JsonlSessionStore({ sessionsDir: dir });
    const session = makeSession();
    await store.save(session.id, session);

    // 模拟历史 state.json：turns[].input 带全量历史快照
    const statePath = join(dir, `${toSessionFileName(session.id)}.state.json`);
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    state.turns = [
      {
        id: 'turn_legacy',
        input: [{ role: 'user', content: 'huge history snapshot', timestamp: 1 }],
        output: { role: 'assistant', content: 'ok', timestamp: 2 },
        durationMs: 0,
        model: 'test-model',
        timestamp: 3,
      },
    ];
    await writeFile(statePath, JSON.stringify(state, null, 2));

    const reloaded = await store.load(session.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.turns).toHaveLength(1);
    // 读取即剥：不得再暴露 input 全量快照
    expect('input' in reloaded!.turns[0]).toBe(false);
    // 其余账本字段保全（枚举输入键逐一断言，防漏映射）
    const legacyTurn = state.turns[0];
    for (const key of Object.keys(legacyTurn)) {
      if (key === 'input') continue;
      expect(key in reloaded!.turns[0]).toBe(true);
      expect((reloaded!.turns[0] as unknown as Record<string, unknown>)[key]).toEqual(legacyTurn[key]);
    }
  });

  it('save rewrites state.json without turns[].input (first-save slimming)', async () => {
    const store = new JsonlSessionStore({ sessionsDir: dir });
    const session = makeSession();
    await store.save(session.id, session);

    const statePath = join(dir, `${toSessionFileName(session.id)}.state.json`);
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    state.turns = [
      {
        id: 'turn_legacy',
        input: [{ role: 'user', content: 'huge history snapshot', timestamp: 1 }],
        output: { role: 'assistant', content: 'ok', timestamp: 2 },
        durationMs: 0,
        model: 'test-model',
        timestamp: 3,
      },
    ];
    await writeFile(statePath, JSON.stringify(state, null, 2));

    // 读出再写回：磁盘上的 turns[].input 应消失
    const reloaded = (await store.load(session.id))!;
    await store.save(session.id, reloaded);
    const rewritten = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(rewritten.turns).toHaveLength(1);
    expect('input' in rewritten.turns[0]).toBe(false);
    expect(rewritten.turns[0].id).toBe('turn_legacy');

    // 换新实例重读（防只在内存里瘦身的假绿）
    const fresh = new JsonlSessionStore({ sessionsDir: dir });
    const reread = await fresh.load(session.id);
    expect(reread!.turns[0].id).toBe('turn_legacy');
    expect(reread!.turns[0].output).toEqual({ role: 'assistant', content: 'ok', timestamp: 2 });
    expect('input' in reread!.turns[0]).toBe(false);
  });

  it('new-style turn ledger round-trips with field preservation', async () => {
    const store = new JsonlSessionStore({ sessionsDir: dir });
    const session = makeSession({
      turns: [
        {
          id: 'turn_1',
          inputCount: 42,
          output: { role: 'assistant', content: 'answer', timestamp: 5, agentId: 'default' },
          durationMs: 12,
          model: 'test-model',
          timestamp: 5,
        },
      ],
    });
    await store.save(session.id, session);

    // 换新实例重读
    const fresh = new JsonlSessionStore({ sessionsDir: dir });
    const reread = await fresh.load(session.id);
    expect(reread!.turns).toHaveLength(1);
    const original = session.turns[0] as unknown as Record<string, unknown>;
    const loaded = reread!.turns[0] as unknown as Record<string, unknown>;
    for (const key of Object.keys(original)) {
      expect(key in loaded).toBe(true);
    }
    expect(loaded.inputCount).toBe(42);
    expect(loaded.model).toBe('test-model');
  });
});
