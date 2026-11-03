/**
 * notify 落库与运行中 Run 的竞态（回归）
 *
 * 背景（2026-11-04 定位）：session schedule 的 notify 通道无锁 `load → push → save`，
 * 而 Run 在整个运行期持有 session lease 并持续 `syncMessages`。`JsonlSessionStore
 * .syncMessages` 以调用方序列为权威——检测到磁盘被旁路改写就整文件重写。于是：
 *
 *   notify 写盘 → UI 已广播 → 下一次 syncMessages 判「漂移」→ 整文件重写 → 通知消失
 *
 * 用户看见了通知，但历史里没有，且无错误可观测。
 *
 * 修复：notify 与 Runner 共 session lease（延迟到 Run 结束落库）。本测试钉两件事：
 * 1. 无锁写入确实会被增量同步抹掉（复现缺陷，防未来退化回旧写法）
 * 2. 持锁写入不被抹掉（修复有效）
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import { InProcessSessionLock } from '@octopi-agent/engine/harness/run/concurrency/session-lease.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { Message } from '@octopi-agent/core/types.js';

const SESSION_ID = 's-notify';

/**
 * 构造测试会话
 *
 * @param messages - 初始消息
 * @returns 会话数据
 */
function makeSession(messages: Message[]): SessionData {
  return {
    id: SESSION_ID,
    agentId: 'agent-a',
    primaryAgentId: 'agent-a',
    meta: {
      id: SESSION_ID,
      agentId: 'agent-a',
      channelId: 'test',
      peerId: 'user',
      status: 'idle',
      createdAt: 1,
      sessionStartedAt: 1,
      lastInteractionAt: 1,
      updatedAt: 1,
      participantAgentIds: ['agent-a'],
    },
    messages,
    turns: [],
    metadata: {},
  } as SessionData;
}

/**
 * 构造一条用户消息
 *
 * @param content - 文本
 * @returns 消息
 */
function userMsg(content: string): Message {
  return { role: 'user', content, timestamp: Date.now() } as Message;
}

/** 通知消息的形状（与 gateway setNotify 写入的一致） */
function notifyMsg(content: string): Message {
  return {
    role: 'user',
    content,
    timestamp: Date.now(),
    agentId: 'agent-a',
    metadata: {
      source: 'runtime',
      origin: 'session_schedule',
      scheduleId: 'sch-1',
      delivery: 'notify',
      triggerType: 'schedule',
    },
  } as Message;
}

describe('notify 落库 × 运行中 Run 的竞态', () => {
  let tempDir: string;
  let store: JsonlSessionStore;
  let lease: InProcessSessionLock;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'octopi-notify-race-'));
    store = new JsonlSessionStore({ sessionsDir: join(tempDir, 'sessions') });
    lease = new InProcessSessionLock();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('无锁写入会被 Run 的增量同步抹掉（缺陷复现）', async () => {
    // 初始历史
    const initial = [userMsg('hi')];
    await store.save(SESSION_ID, makeSession(initial));

    // Run 拿锁并读入内存（之后不再 load）
    const release = await lease.acquire(SESSION_ID);
    const runMessages: Message[] = [...initial, userMsg('turn 1')];
    await store.syncMessages(SESSION_ID, runMessages);

    // notify 无锁写入（旧实现）
    const loaded = await store.load(SESSION_ID);
    expect(loaded).not.toBeNull();
    loaded!.messages.push(notifyMsg('<schedule_notify/>'));
    await store.save(SESSION_ID, loaded!);

    // 此刻通知确实在盘上
    const afterNotify = await store.load(SESSION_ID);
    expect(afterNotify!.messages.some((m) => m.content === '<schedule_notify/>')).toBe(true);

    // Run 继续推进并再次同步 → 以自身内存为权威
    runMessages.push(userMsg('turn 2'));
    await store.syncMessages(SESSION_ID, runMessages);
    release();

    // 缺陷：通知消失，且没有任何错误
    const final = await store.load(SESSION_ID);
    expect(final!.messages.some((m) => m.content === '<schedule_notify/>')).toBe(false);
  });

  it('持锁写入不被抹掉（修复有效）', async () => {
    const initial = [userMsg('hi')];
    await store.save(SESSION_ID, makeSession(initial));

    // Run 拿锁
    const runRelease = await lease.acquire(SESSION_ID);
    const runMessages: Message[] = [...initial, userMsg('turn 1')];
    await store.syncMessages(SESSION_ID, runMessages);

    // notify 排队等锁（新实现），Run 收尾整包 save 后才轮到它
    const notifyDone = (async () => {
      const release = await lease.acquire(SESSION_ID);
      try {
        const session = await store.load(SESSION_ID);
        session!.messages.push(notifyMsg('<schedule_notify/>'));
        await store.save(SESSION_ID, session!);
      } finally {
        release();
      }
    })();

    // Run 收尾整包 save + 释放锁（顺序与 Runner 一致）
    await store.save(SESSION_ID, { ...makeSession(runMessages) });
    runRelease();
    await notifyDone;

    // 修复：通知存活
    const final = await store.load(SESSION_ID);
    expect(final!.messages.some((m) => m.content === '<schedule_notify/>')).toBe(true);
  });

  it('通知延迟落库后可被下一次 Run 读到（语义：不打断当前 Run）', async () => {
    const initial = [userMsg('hi')];
    await store.save(SESSION_ID, makeSession(initial));

    // Run 运行中：通知在等锁，不会进入本次 Run 的内存序列
    const runRelease = await lease.acquire(SESSION_ID);
    const runMessages: Message[] = [...initial, userMsg('turn 1')];
    await store.syncMessages(SESSION_ID, runMessages);

    let notifyLanded = false;
    const notifyDone = (async () => {
      const release = await lease.acquire(SESSION_ID);
      try {
        const session = await store.load(SESSION_ID);
        session!.messages.push(notifyMsg('<schedule_notify/>'));
        await store.save(SESSION_ID, session!);
        notifyLanded = true;
      } finally {
        release();
      }
    })();

    // 当前 Run 已定形的序列里没有通知（不打断）
    expect(runMessages.some((m) => m.content === '<schedule_notify/>')).toBe(false);
    expect(notifyLanded).toBe(false);

    await store.save(SESSION_ID, { ...makeSession(runMessages) });
    runRelease();
    await notifyDone;

    // 下一次 Run 开头 load 就能看到
    const nextLoad = await store.load(SESSION_ID);
    expect(nextLoad!.messages.some((m) => m.content === '<schedule_notify/>')).toBe(true);
  });
});
